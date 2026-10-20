import { makeProjectMemoryModelExchange } from "../../server.ts";
import * as MemoryModelPorts from "../../projectWork/memory/ProjectMemoryPorts.ts";
import { projectMemorySourceSelection } from "../../projectWork/memory/ProjectMemorySharing.ts";
import * as PiOperations from "../../projectWork/ProjectTeamPiOperations.ts";
import type { PiWorkerFrame } from "./PiWorkerProtocol.ts";
import { decodePiParentFrame } from "./PiWorkerProtocol.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as GitManager from "../../git/GitManager.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { vi } from "vite-plus/test";
import { makeProjectTeamReviewCompletionProposals } from "../../projectWork/ProjectTeamReviewCompletionProposals.ts";
import { makeProjectTeamReviewCompletion } from "../../projectWork/ProjectTeamReviewCompletion.ts";
import * as SessionRuntime from "./PiSessionRuntime.ts";
import * as ManagedProcess from "./PiManagedProcess.ts";
import * as RuntimeLive from "./PiManagedRuntimeLive.ts";
import * as ProjectWorkTools from "./PiProjectWorkTools.ts";
import { makePiProductionRuntime, type PiProductionRuntimeAssets } from "./PiProductionRuntime.ts";
import { withProjectWorkVerificationExecutable } from "../../projectWork/ProjectWorkVerificationExecutable.ts";
import {
  makeProjectTeamReviewCurrentTarget,
  ProjectTeamReviewCurrentTarget,
} from "../../projectWork/ProjectTeamReviewCurrentTarget.ts";
import { PiModelCatalogue } from "./PiModelCatalogue.ts";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
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
  OrchestrationProjectShell,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectWorkTaskRead,
  ProjectWorkWriteResult,
  ProjectWorkEvidenceRead,
  ProjectWorkComment,
  ProjectWorkDecision,
  ProjectTeamMemorySourcesRead,
  ProjectTeamMemoryProcessIntent,
  ProjectTeamMemoryQueryIntent,
  type ProjectTeamMemorySourceSelector,
  type ProjectMemoryObservation,
  ProjectTeamMemorySharedSourcesRead,
  ProjectTeamMemorySharesReplaceIntent,
  ManagedSkillKey,
  SkillCatalogRevision,
  ProjectTeamGuidedIntent,
  type ProjectTeamReviewCriterionAssessment,
  ProjectWorkFoundationCommitCommand,
  ProjectTeamWriteIntent,
  ProjectWorkTaskId,
  ProviderDriverKind,
  ProjectId,
  ThreadId,
  ProjectWorkCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import { makeProviderServiceLive } from "../Layers/ProviderService.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderSessionDirectoryLive } from "../Layers/ProviderSessionDirectory.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { ProviderEventLoggers, NoOpProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { startManagedProviderSession } from "../ProviderManagedSessions.ts";
import { ProviderValidationError } from "../Errors.ts";
import { SkillCatalogService } from "../../skills/SkillCatalogService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { createEmptyReadModel } from "../../orchestration/projector.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { GitRepositoryPermits } from "../../git/GitRepositoryPermits.ts";
import * as ManagedGit from "../../git/ManagedGitExecution.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeProjectTeamWorkspace } from "../../projectWork/ProjectTeamWorkspace.ts";
import {
  makeProjectTeamPiRuntime,
  ProjectTeamPiRuntime,
} from "../../projectWork/ProjectTeamPiRuntime.ts";
import {
  makeProjectWorkVerificationPreparationRoot,
  ProjectWorkVerificationPreparationSelection,
  ProjectWorkVerificationPreparationError,
} from "../../projectWork/ProjectWorkVerificationPreparation.ts";
import { makeProjectWorkVerificationExecutionHost } from "../../projectWork/ProjectWorkVerificationExecutionHost.ts";
import { makeProjectWorkVerificationExecution } from "../../projectWork/ProjectWorkVerificationExecution.ts";
import { ProjectWorkEventBusLive } from "../../projectWork/ProjectWorkEventBus.ts";
import { makeProjectWorkArtifacts } from "../../projectWork/ProjectWorkArtifacts.ts";
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
import { makeProjectTaskResources } from "../../projectWork/ProjectTaskResources.ts";
import { makeProjectTeamSessionReceipts } from "../../projectWork/ProjectTeamSessionReceipts.ts";
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
import * as VerificationPreparation from "../../projectWork/ProjectWorkVerificationPreparation.ts";
import { makeProjectWorkVerificationJobs } from "../../projectWork/ProjectWorkVerificationJobs.ts";
import {
  makeProjectWorkVerificationGate,
  ProjectWorkVerificationApproval,
  ProjectWorkVerificationGateError,
} from "../../projectWork/ProjectWorkVerificationGate.ts";
import { prepareProjectTeamConfiguredAdmission } from "../../projectWork/ProjectTeamConfiguredAdmission.ts";
import {
  ProjectWorkVerificationRequest,
  ProjectWorkVerificationRequestError,
} from "../../projectWork/ProjectWorkVerificationRequest.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import { readProjectTeamBindingAccountingInTransaction } from "../../projectWork/ProjectTeamUsageRead.ts";
import type { ProjectTeamPiSubscriptionTestSelection } from "../../projectWork/ProjectTeamModelAccounting.ts";
import * as PiModelAccounting from "../../projectWork/ProjectTeamModelAccounting.ts";
import { ProjectLifecycle, ProjectLifecycleLive } from "../../project/ProjectLifecycle.ts";
import { readProjectMemoryProjectionSyncInTransaction } from "../../projectWork/memory/ProjectMemoryProjectDeletion.ts";
import * as DispatchJournal from "../../projectWork/ProjectTeamDispatchJournal.ts";
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
import {
  makeProjectMemoryProcessingConsumer,
  type ProjectMemoryProcessingConsumerOptions,
} from "../../projectWork/memory/ProjectMemoryProcessing.ts";
import { makeProjectMemoryCompanion } from "../../projectWork/memory/ProjectMemoryCompanion.ts";
import {
  makeProjectMemoryCompanionJournal,
  decodeProjectMemoryCompanionIntent,
} from "../../projectWork/memory/ProjectMemoryCompanionJournal.ts";
import {
  MemoryIndexManifest,
  MemoryBackendSource,
  MemoryBackendError,
  MemoryBackendSearch,
} from "../../projectWork/memory/MemoryBackend.ts";
import {
  ProjectMemoryJobOwner,
  ProjectMemoryOperation,
  ProjectMemoryOperationIdentity,
  makeProjectMemoryModelAccounting,
  auditProjectMemoryOperationLedger,
  ProjectMemorySettlement,
} from "../../projectWork/memory/ProjectMemoryModelAccounting.ts";
import type { ProjectMemoryRetrieval } from "../../projectWork/memory/ProjectMemoryRetrieval.ts";
import {
  ProjectMemoryServiceError,
  makeProjectMemoryService,
  projectMemoryHash,
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
  ProjectWorkAuthorizationError,
  type ProjectWorkGatewayShape,
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
import { makePiModelBroker } from "./PiModelBroker.ts";

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
const decodeNativeReadOutput = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
    }),
  ),
);
const decodeNativeReportParameters = Schema.decodeUnknownSync(
  Schema.Struct({
    properties: Schema.Struct({ intentJSON: Schema.Struct({ description: Schema.String }) }),
  }),
);
const decodeNativeReportTemplate = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.JsonObject),
);
const decodeReviewNativeRequest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
      tools: Schema.Array(
        Schema.Struct({
          function: Schema.Struct({ name: Schema.String, parameters: Schema.JsonObject }),
        }),
      ),
    }),
  ),
);
const decodeNativeAllocation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ManagedProcess.PiManagedProcessAllocationSchema),
);
const encodeFixtureWorkspaceReceipt = Schema.encodeSync(
  Schema.fromJsonString(DispatchJournal.ProjectTeamWorkspaceReceipt),
);
const decodeNativeOwner = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("owner"),
      unit: Schema.String,
      nonce: Schema.String,
      invocation: Schema.String,
      cgroup: Schema.String,
      pid: Schema.Int,
      memoryBytes: Schema.Int,
      swapBytes: Schema.Int,
      oomGroup: Schema.Int,
    }),
  ),
  { onExcessProperty: "error" },
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
const decodeNativeSmokeCommand = Schema.decodeUnknownEffect(ProjectWorkCommand);
const decodeNativeJsonEvidence = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject));
const decodeNativeSmokeShell = Schema.decodeUnknownSync(OrchestrationProjectShell);
const decodeNativeVerificationSelection = Schema.decodeUnknownEffect(
  ProjectWorkVerificationPreparationSelection,
);
const decodeReportEvidence = Schema.decodeUnknownEffect(Schema.Array(ProjectWorkEvidenceRead));
const decodeReportComments = Schema.decodeUnknownEffect(Schema.Array(ProjectWorkComment));
const decodeMemorySources = Schema.decodeUnknownEffect(ProjectTeamMemorySourcesRead);
const decodeMemoryOwnerRequest = Schema.decodeUnknownEffect(ProjectTeamMemoryProcessIntent);
const decodeMemoryQueryRequest = Schema.decodeUnknownEffect(ProjectTeamMemoryQueryIntent);
const decodeMemorySourceComment = Schema.decodeUnknownEffect(ProjectWorkComment);
const decodeMemorySourceDecision = Schema.decodeUnknownEffect(ProjectWorkDecision);
const isManagedRuntimeError = Schema.is(PiManagedRuntimeError);
const controlledCallbackError = (cause: unknown) =>
  isManagedRuntimeError(cause)
    ? cause
    : new PiManagedRuntimeError({ code: "uncertain", detail: "Controlled callback failed" });
const ownedReviewNativeAssets = (
  assets: Effect.Success<ReturnType<typeof preparePiRuntimeAssets>>,
): PiProductionRuntimeAssets => {
  const revalidate = assets.revalidate.pipe(Effect.mapError(controlledCallbackError));
  return {
    runtimeFiles: assets.runtimeFiles,
    revalidate,
    borrow: <A, E, R>(use: Effect.Effect<A, E, R>) => revalidate.pipe(Effect.andThen(use)),
  };
};
const isControlledProcessError = Schema.is(ManagedProcess.PiManagedProcessError);
const isControlledBackendError = Schema.is(MemoryBackendError);

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const decodeReportSchemaObject = Schema.decodeUnknownSync(Schema.JsonObject);
const decodeReportGuidedIntent = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProjectTeamGuidedIntent),
);
const reportTemplateDescription = (schemaInput: unknown): string | undefined => {
  const schema = decodeReportSchemaObject(schemaInput);
  if (!isRecord(schema.properties) || !isRecord(schema.properties.intentJSON)) return undefined;
  return typeof schema.properties.intentJSON.description === "string"
    ? schema.properties.intentJSON.description
    : undefined;
};
const decodeReportTemplate = (description: string) => {
  try {
    return decodeReportGuidedIntent(description);
  } catch {
    return undefined;
  }
};
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
const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>, memoryRetraction = false) =>
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
      const gateway = memoryRetraction
        ? ProjectWorkGatewayLive.pipe(
            Layer.provideMerge(ProjectWorkContentGuardLive),
            Layer.provideMerge(
              Layer.succeed(
                ServerEnvironmentIdentity,
                ServerEnvironmentIdentity.of({
                  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
                }),
              ),
            ),
          )
        : ProjectWorkGatewayLive;
      const live = gateway.pipe(
        Layer.provideMerge(services),
        Layer.provide(Layer.mock(EnvironmentAuth)({})),
        Layer.provideMerge(ServerSettings.layerTest({ projectWorkEnabled: true })),
        Layer.provideMerge(makeSqlitePersistenceLive(directory + "/native-runtime.sqlite")),
        Layer.provideMerge(
          Layer.merge(
            Layer.mock(GitWorkflowService, {
              withRepositoryPermit: (_operation, _cwd, use) => use,
            }),
            Layer.mock(GitRepositoryPermits, {
              withRepositoryPermit: (_operation, _cwd, use) => use,
            }),
          ),
        ),
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
        const f = yield* dispatchedRuntimeFixture();
        const request = {
          threadId,
          kind: "initialize" as const,
          operationId: f.request.initializeOperationId,
        };
        const prepared = yield* f.instance.prepareOperation(request, () => Effect.void);
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
        yield* rejected(f.instance.prepareOperation(request, () => Effect.void));
        const budget = yield* f.sql`SELECT * FROM project_team_model_budget`;
        yield* f.instance.requestStop(threadId);
        expect(
          (yield* f.sql<{ status: string }>`SELECT status FROM project_team_pi_operation`)[0]
            ?.status,
        ).toBe("settled");
        yield* rejected(prepared.run);
        yield* rejected(f.instance.prepareOperation(request, () => Effect.void));
        expect(yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).toEqual([
          { operation_id: f.request.initializeOperationId },
        ]);
        expect(
          yield* f.sql`SELECT status,owner_json,drain_json FROM project_team_pi_process`,
        ).toEqual([{ status: "drained", owner_json: null, drain_json: null }]);
        expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toEqual(budget);
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
it.effect("denies managed preparation without original dispatch operation identity", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const reader = yield* makeProjectTeamContext({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 128,
      });
      const identity = {
        projectId: f.binding.projectId,
        bindingId: f.binding.recordId,
        generation: f.binding.generation,
        providerInstanceId,
        threadId,
        operationKind: "initialize" as const,
      };
      expect(yield* f.sql`SELECT dispatch_id FROM project_team_dispatch`).toEqual([]);
      expect(
        yield* reader.readForOperation({ ...identity, operationId: "" }).pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ProjectTeamContextError",
          reason: "Required operation identity is invalid",
        },
      });
      expect(
        yield* reader
          .readForOperation({ ...identity, operationId: "absent-dispatch-initialize" })
          .pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ProjectTeamContextError",
          reason: "Required original dispatch is unavailable",
        },
      });
      yield* rejected(
        f.instance.prepareOperation({ threadId, kind: "initialize" }, () => Effect.void),
      );
      yield* rejected(
        f.instance.prepareOperation(
          { threadId, kind: "initialize", operationId: "absent-dispatch-initialize" },
          () => Effect.void,
        ),
      );
      expect(yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).toEqual([]);
      expect(f.launches).toBe(0);
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
      const f = yield* dispatchedRuntimeFixture();
      const prepared = yield* f.instance.prepareOperation(
        { threadId, kind: "initialize", operationId: f.request.initializeOperationId },
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
        const f = yield* dispatchedRuntimeFixture();
        const custom = f.main + "-credentials";
        const inside = f.worktree + "/credentials";
        yield* f.fs.makeDirectory(custom);
        yield* f.fs.makeDirectory(inside);
        const insideInstance = yield* f.runtime.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: { agentDirectory: inside },
        });
        let overlap: unknown;
        const preallocate = ManagedProcess.preallocatePiManagedProcess;
        const overlapSpy = vi
          .spyOn(ManagedProcess, "preallocatePiManagedProcess")
          .mockImplementation((input) =>
            preallocate(input).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  overlap = error;
                }),
              ),
            ),
          );
        expect(
          yield* insideInstance
            .prepareOperation(
              { threadId, kind: "initialize", operationId: f.request.initializeOperationId },
              () => Effect.void,
            )
            .pipe(Effect.result, Effect.ensuring(Effect.sync(() => overlapSpy.mockRestore()))),
        ).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "PiManagedRuntimeError", code: "unavailable" },
        });
        expect(overlap).toMatchObject({
          _tag: "PiManagedProcessError",
          phase: "validation",
          message: "Assigned cwd overlaps protected data.",
        });
        expect(yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).toEqual([]);
        expect(yield* f.sql`SELECT unit FROM project_team_pi_process`).toEqual([]);
        expect(f.allocations).toBe(1);
        expect(f.transports).toBe(0);
        const outsideInstance = yield* f.runtime.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: { agentDirectory: custom },
        });
        const prepared = yield* outsideInstance.prepareOperation(
          { threadId, kind: "initialize", operationId: f.request.initializeOperationId },
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
          const profile = {
            ...basicRuntimeProfile,
            role: toolIds.some((tool) => ["pi.write", "pi.edit", "pi.bash"].includes(tool))
              ? ("implementer" as const)
              : ("investigator" as const),
            roleTools,
            toolIds,
          };
          if (toolIds.some((tool) => !roleTools.includes(tool))) {
            expect(available).toBe(false);
            expect(yield* dispatchedRuntimeFixture(profile).pipe(Effect.result)).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "ProjectWorkPolicyError", code: "authority-required" },
            });
            const sql = yield* SqlClient.SqlClient;
            expect(yield* sql`SELECT operation_id FROM project_team_pi_operation`).toEqual([]);
            expect(yield* sql`SELECT unit FROM project_team_pi_process`).toEqual([]);
            return;
          }
          const f = yield* dispatchedRuntimeFixture(profile);
          const before = (yield* f.sql`SELECT * FROM project_team_pi_process`).length;
          if (available) {
            const prepared = yield* f.instance.prepareOperation(
              { threadId, kind: "initialize", operationId: f.request.initializeOperationId },
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
              f.instance.prepareOperation(
                { threadId, kind: "initialize", operationId: f.request.initializeOperationId },
                () => Effect.void,
              ),
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
const selectedRuntimeFixture = Effect.fn("PiManagedRuntimeLive.selectedRuntimeFixture")(function* (
  genuine = false,
) {
  const historical = genuine ? undefined : yield* fixture;
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
  const dispatched = genuine
    ? yield* dispatchedRuntimeFixture({
        ...basicRuntimeProfile,
        roleSkillIds: [skill.manifest.id],
        skillIds: [skill.manifest.id],
      })
    : undefined;
  const f = historical ?? dispatched;
  if (!f) return yield* Effect.die("Missing selected runtime fixture");
  if (historical) {
    yield* restoreHistoricalBinding({
      ...historical.role,
      revision: historical.role.revision + 1,
      skills: [skill.manifest.id],
    });
    yield* restoreHistoricalBinding({
      ...historical.binding,
      revision: historical.binding.revision + 1,
      configuration: { ...historical.binding.configuration, skillIds: [skill.manifest.id] },
    });
  }
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
    originalInitializeOperationId: () => {
      if (!dispatched) throw Error("Historical selected fixture has no original dispatch ID");
      return dispatched.request.initializeOperationId;
    },
    get launches() {
      if (historical) return historical.launches;
      if (dispatched) return dispatched.allocations;
      throw Error("Missing selected runtime fixture");
    },
    get transports() {
      return f.transports;
    },
  };
});
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
        const f = yield* selectedRuntimeFixture(true);
        const prepared = yield* f.instance.prepareOperation(
          {
            threadId,
            kind: "initialize",
            operationId: f.originalInitializeOperationId(),
            skillPlan: f.plan,
          },
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
        const f = yield* selectedRuntimeFixture(true);
        yield* rejected(
          f.instance.prepareOperation(
            { threadId, kind: "initialize", operationId: f.originalInitializeOperationId() },
            () => Effect.void,
          ),
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
      const f = yield* selectedRuntimeFixture(true);
      const request = {
        threadId,
        kind: "initialize" as const,
        operationId: f.originalInitializeOperationId(),
        skillPlan: f.plan,
      };
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
      const f = yield* selectedRuntimeFixture(true);
      yield* f.fs.writeFileString(
        f.skill.packagePath + "/SKILL.md",
        "Changed after actual materialization",
      );
      yield* rejected(
        f.instance.prepareOperation(
          {
            threadId,
            kind: "initialize",
            operationId: f.originalInitializeOperationId(),
            skillPlan: f.plan,
          },
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
  f: Pick<Effect.Success<typeof fixture>, "worktree" | "options" | "sql">,
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
for (const host of [
  "blocked",
  "revoked",
  "foreign-worker",
  "foreign-generation",
  "foreign-operation",
  "sequence-gap",
  "malformed-ack",
] as const)
  it.effect(`managed ACK observer retains ${host} authority and protocol fences`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* requiredTransferFixture();
        yield* initializeRequiredContext(f);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let armed = false;
        let authorityCalls = 0;
        const makeOperations = PiOperations.makeProjectTeamPiOperations;
        const authoritySpy = vi
          .spyOn(PiOperations, "makeProjectTeamPiOperations")
          .mockImplementation((options) =>
            makeOperations(options).pipe(
              Effect.map((operations) => ({
                ...operations,
                authorize: (operation) =>
                  Effect.gen(function* () {
                    if (armed) {
                      authorityCalls++;
                      yield* Deferred.succeed(entered, undefined);
                      if (host === "blocked") yield* Deferred.await(release);
                    }
                    return yield* operations.authorize(operation);
                  }),
              })),
            ),
          );
        yield* Effect.addFinalizer(() => Effect.sync(() => authoritySpy.mockRestore()));
        const runtime = yield* makePiManagedRuntimeLive(f.options);
        const instance = yield* runtime.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: {},
        });
        let captured: SessionRuntime.PiSessionRuntimeOptions | undefined;
        const makeSession = SessionRuntime.makePiSessionRuntime;
        const sessionSpy = vi
          .spyOn(SessionRuntime, "makePiSessionRuntime")
          .mockImplementation((input) => {
            captured = input;
            return makeSession(input);
          });
        yield* Effect.addFinalizer(() => Effect.sync(() => sessionSpy.mockRestore()));
        const observed: unknown[] = [];
        yield* instance.prepareOperation(
          {
            threadId: f.binding.threadId,
            kind: "prompt",
            operationId: f.request.assignmentOperationId,
            prompt: f.request.assignment,
          },
          (event) =>
            Effect.sync(() => {
              observed.push(event);
            }),
        );
        if (!captured?.onWorkerFrame) return yield* Effect.die("Missing actual managed observer");
        const session = captured;
        const signal = new AbortController().signal;
        const frame = (sequence: number, message: PiWorkerFrame["message"]): PiWorkerFrame => ({
          version: 1,
          ...session.identity,
          ...session.operation,
          sequence,
          message,
        });
        const invoke = (value: PiWorkerFrame) =>
          Effect.tryPromise({
            try: () => session.onWorkerFrame!(value, signal),
            catch: controlledCallbackError,
          });
        if (host === "revoked")
          yield* restoreHistoricalBinding({
            ...f.binding,
            revision: f.binding.revision + 1,
            status: "revoked",
          });
        armed = true;
        if (host !== "blocked" && host !== "revoked") {
          const invalid: PiWorkerFrame = {
            ...frame(host === "sequence-gap" ? 1 : 0, {
              type: "ack",
              requestId: 1,
              chunkSequence: host === "malformed-ack" ? -1 : 3,
            }),
            ...(host === "foreign-worker"
              ? { workerId: session.identity.workerId + "-foreign" }
              : {}),
            ...(host === "foreign-generation"
              ? { generation: session.identity.generation + 1 }
              : {}),
            ...(host === "foreign-operation"
              ? { operationId: session.operation.operationId + "-foreign" }
              : {}),
          };
          expect((yield* invoke(invalid).pipe(Effect.result))._tag).toBe("Failure");
          expect(authorityCalls).toBe(0);
          expect(observed).toEqual([]);
          return;
        }
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        const ack = yield* invoke(frame(0, { type: "ack", requestId: 1, chunkSequence: 3 })).pipe(
          Effect.result,
          Effect.forkChild,
        );
        const receipt = yield* Effect.raceFirst(
          Fiber.join(ack).pipe(
            Effect.map((result) => (result._tag === "Success" ? "ack-consumed" : "ack-rejected")),
          ),
          Deferred.await(entered).pipe(Effect.as("authority-entered")),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(ack);
        expect(receipt).toBe("ack-consumed");
        expect(authorityCalls).toBe(0);
        expect(observed).toEqual([]);
        // The next non-ACK frame proves ACK consumed the translator's sequence cursor.
        armed = false;
        const next = yield* invoke(frame(1, { type: "agent_start", lifecycleId: 1 })).pipe(
          Effect.result,
        );
        expect(next._tag).toBe(host === "blocked" ? "Success" : "Failure");
        armed = true;
        if (host === "blocked") {
          // Keep this fence's authorizer denied after the ACK receipt completed.
          yield* restoreHistoricalBinding({
            ...f.binding,
            revision: f.binding.revision + 1,
            status: "revoked",
          });
        }
        for (const phase of ["beforeForward", "beforeReturn"] as const) {
          expect(
            (yield* Effect.tryPromise({
              try: () => session.broker.authorizeCurrent!(phase, signal),
              catch: controlledCallbackError,
            }).pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        for (const phase of ["beforeToolInvoke", "beforeToolReturn", "beforeStart"] as const)
          expect(
            (yield* Effect.tryPromise({
              try: () =>
                session.authorizeCurrent(
                  { phase, identity: session.identity, operation: session.operation },
                  signal,
                ),
              catch: controlledCallbackError,
            }).pipe(Effect.result))._tag,
          ).toBe("Failure");
        expect(authorityCalls).toBeGreaterThan(0);
        expect(f.transports).toBe(0);
      }),
    ),
  );

const reportInputFeedbackFixture = Effect.fn("reportInputFeedbackFixture")(function* (
  write?: ProjectWorkGatewayShape["write"],
) {
  const f = yield* requiredTransferFixture(
    false,
    false,
    undefined,
    false,
    "project",
    "Retain the assignment report",
    {
      ...basicRuntimeProfile,
      roleTools: ["project-work.report"],
      toolIds: ["project-work.report"],
      deliverableKind: "non-code",
    },
  );
  const actualGateway = yield* ProjectWorkGateway;
  let reads = 0;
  const writes: Array<Parameters<ProjectWorkGatewayShape["write"]>> = [];
  const gateway = ProjectWorkGateway.of({
    ...actualGateway,
    read: (...args) =>
      Effect.sync(() => {
        reads++;
      }).pipe(Effect.andThen(actualGateway.read(...args))),
    write: (...args) =>
      Effect.sync(() => {
        writes.push(args);
      }).pipe(Effect.andThen((write ?? actualGateway.write)(...args))),
  });
  const runtime = yield* makePiManagedRuntimeLive(f.options).pipe(
    Effect.provideService(ProjectWorkGateway, gateway),
  );
  const instance = yield* runtime.forInstance({
    instanceId: providerInstanceId,
    enabled: true,
    configuration: {},
  });
  yield* initializeRequiredContext(f, false, instance);
  let captured: SessionRuntime.PiSessionRuntimeOptions | undefined;
  const original = SessionRuntime.makePiSessionRuntime;
  const capture = vi.spyOn(SessionRuntime, "makePiSessionRuntime").mockImplementation((input) => {
    captured = input;
    return original(input);
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => capture.mockRestore()));
  yield* instance.prepareOperation(
    {
      threadId: f.binding.threadId,
      kind: "prompt",
      operationId: f.request.assignmentOperationId,
      prompt: f.request.assignment,
    },
    () => Effect.void,
  );
  if (!captured) return yield* Effect.die("No report session callback captured");
  const session = captured;
  const schemaText = session.transferTexts.find(
    (entry) => entry.transferId === "project_work_report",
  )?.text;
  if (schemaText === undefined) return yield* Effect.die("Missing advertised report schema");
  const description = reportTemplateDescription(decodeNativeJsonEvidence(schemaText));
  const template = description === undefined ? undefined : decodeReportTemplate(description);
  if (template?.type !== "project-team.assignment.report")
    return yield* Effect.die("Missing advertised assignment report intent");
  const intent = {
    ...template,
    summary: "Retained findings without a claim of completed verification",
  };
  let callId = 0;
  const invoke = Effect.fn("reportInputFeedbackFixture.invoke")(function* (
    toolName: string,
    arguments_: Parameters<
      SessionRuntime.PiSessionRuntimeOptions["executeBridgeTool"]
    >[1]["arguments"],
    signal = new AbortController().signal,
  ) {
    const input = { arguments: arguments_ };
    const id = ++callId;
    return yield* Effect.tryPromise({
      try: () =>
        session.executeBridgeTool(
          {
            type: "tool-call",
            callId: id,
            nativeCallId: "report-feedback-" + id,
            lifecycleId: 1,
            toolName,
            execution: "bridge",
            input: {
              transferId: "report-feedback-input-" + id,
              totalBytes: Buffer.byteLength(json(input)),
            },
          },
          input,
          signal,
        ),
      catch: controlledCallbackError,
    });
  });
  const durable = Effect.gen(function* () {
    return {
      budgets: yield* f.sql`SELECT * FROM project_team_model_budget`,
      operations: yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_id`,
      dispatches: yield* f.sql`SELECT * FROM project_team_dispatch ORDER BY dispatch_id`,
      models: yield* f.sql`SELECT * FROM project_team_model_request`,
      processes: yield* f.sql`SELECT * FROM project_team_pi_process ORDER BY operation_id`,
      allocations: f.allocations,
      transports: f.transports,
    };
  });
  reads = 0;
  writes.length = 0;
  return {
    f,
    session,
    intent,
    invoke,
    durable,
    writes,
    get reads() {
      return reads;
    },
  };
});

describe("assignment report input feedback", () => {
  it.effect("allows caller correction after rejection within the original operation budget", () =>
    scoped(
      Effect.gen(function* () {
        const fixture = yield* reportInputFeedbackFixture();
        const { f, session, invoke, durable, writes } = fixture;
        const hostile = "PRIVATE_REPORT_INPUT_do_not_echo_" + "x".repeat(128);
        const intent = { ...fixture.intent, summary: hostile };
        const before = yield* readCurrentState(f.sql, f.binding.projectId);
        const originalDurable = yield* durable;
        expect(originalDurable.budgets).toHaveLength(1);
        expect(originalDurable.budgets[0]?.deadline_at_ms).toBe(
          f.snapshot.intent.limits.rootDeadlineAtMs,
        );
        expect(originalDurable.models).toEqual([]);
        expect(session.operation.operationId).toBe(f.request.assignmentOperationId);
        const receipts = yield* f.sql`SELECT * FROM project_work_command_receipts`;
        const { type, ...missingType } = intent;
        expect(type).toBe("project-team.assignment.report");
        const { expectedRevision, ...missingRevision } = intent;
        expect(expectedRevision).toBe(before.revision);
        let feedback: string | undefined;
        for (const intentJSON of [
          json(missingType),
          json(missingRevision),
          "{malformed-json-" + hostile.repeat(32),
        ]) {
          const returned = yield* invoke("project_work_report", { intentJSON });
          expect(Object.keys(returned).sort()).toEqual(["kind", "text"]);
          expect(returned.kind).toBe("text");
          if (returned.kind !== "text") return yield* Effect.die("Report rejection was not text");
          expect(returned.text).toMatch(/report (?:was )?rejected/i);
          expect(returned.text).toMatch(/no report (?:was )?recorded/i);
          expect(returned.text).toContain("intentJSON");
          expect(returned.text).toContain("project-team.assignment.report");
          expect(returned.text).toMatch(/advertised/i);
          expect(returned.text).toMatch(/type/);
          expect(returned.text).toMatch(/revision/i);
          expect(Buffer.byteLength(returned.text)).toBeLessThanOrEqual(1024);
          for (const privateText of [hostile, f.binding.recordId, f.binding.worktree])
            expect(returned.text).not.toContain(privateText);
          expect(returned.text).not.toContain("PRIVATE_REPORT_INPUT");
          expect(returned.text).not.toContain("PiProjectWorkToolValidationError");
          expect(returned.text).not.toMatch(/"status"\s*:\s*"accepted"/);
          if (feedback !== undefined) expect(returned.text).toBe(feedback);
          feedback = returned.text;
          expect(fixture.reads).toBe(0);
          expect(writes).toEqual([]);
          expect(yield* readCurrentState(f.sql, f.binding.projectId)).toEqual(before);
          expect(yield* f.sql`SELECT * FROM project_work_command_receipts`).toEqual(receipts);
          expect(yield* durable).toEqual(originalDurable);
          yield* Effect.tryPromise({
            try: () =>
              session.authorizeCurrent(
                {
                  identity: session.identity,
                  operation: session.operation,
                  phase: "beforeToolReturn",
                },
                new AbortController().signal,
              ),
            catch: controlledCallbackError,
          });
        }
        // The caller supplies the complete original intent; the runtime fills in no fields.
        const returned = yield* invoke("project_work_report", { intentJSON: json(intent) });
        expect(writes).toHaveLength(1);
        expect(writes[0]?.[0]).toEqual(intent);
        expect(writes[0]?.[3]?.managed).toMatchObject({
          bindingId: f.binding.recordId,
          generation: f.binding.generation,
          providerInstanceId,
          threadId: f.binding.threadId,
        });
        const accepted = yield* f.sql<{ result_json: string }>`SELECT result_json
          FROM project_work_command_receipts WHERE project_id=${intent.projectId}
          AND command_id=${intent.commandId}`;
        expect(accepted).toHaveLength(1);
        expect((yield* decodeReportReceipt(accepted[0]!.result_json)).receipt).toMatchObject({
          commandId: intent.commandId,
          status: "accepted",
        });
        expect(returned).toEqual({ kind: "text", text: accepted[0]!.result_json });
        expect(
          (yield* readCurrentState(f.sql, f.binding.projectId)).evidence.some(
            (entry) => entry.detail === intent.summary,
          ),
        ).toBe(true);
        expect(yield* durable).toEqual(originalDurable);
        expect(f.transports).toBe(0);
      }),
    ),
  );

  for (const mode of [
    "write-invalid-intent",
    "plan-invalid-intent",
    "report-invalid-arguments",
    "report-intent-kind",
    "unknown-tool",
  ] as const)
    it.effect(`keeps ${mode} fatal`, () =>
      scoped(
        Effect.gen(function* () {
          const fixture = yield* reportInputFeedbackFixture();
          const before = yield* readCurrentState(fixture.f.sql, fixture.f.binding.projectId);
          const originalDurable = yield* fixture.durable;
          const { type, ...missingType } = fixture.intent;
          expect(type).toBe("project-team.assignment.report");
          const result = yield* fixture
            .invoke(
              mode === "write-invalid-intent"
                ? "project_work_write"
                : mode === "plan-invalid-intent"
                  ? "project_work_plan"
                  : mode === "unknown-tool"
                    ? "unknown_project_work_tool"
                    : "project_work_report",
              mode === "report-invalid-arguments"
                ? { intentJSON: 12 }
                : mode === "report-intent-kind"
                  ? {
                      intentJSON: json({
                        type: "project-work.task.create",
                        projectId: fixture.intent.projectId,
                        taskId: "unrelated-report-task",
                        commandId: "unrelated-report-command",
                        title: "Not an assignment report",
                        createdAt: at,
                      }),
                    }
                  : { intentJSON: json(missingType) },
            )
            .pipe(Effect.result);
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "PiManagedRuntimeError", code: "unavailable" },
          });
          expect(fixture.reads).toBe(0);
          expect(fixture.writes).toEqual([]);
          expect(yield* readCurrentState(fixture.f.sql, fixture.f.binding.projectId)).toEqual(
            before,
          );
          expect(yield* fixture.durable).toEqual(originalDurable);
        }),
      ),
    );

  for (const mode of ["authorization", "gateway", "revision-conflict", "unknown-error"] as const)
    it.effect(`keeps ${mode} after valid report decoding fatal`, () =>
      scoped(
        Effect.gen(function* () {
          // Failure stubs exercise propagation only; the correction test uses actual gateway authority.
          const fixture = yield* reportInputFeedbackFixture(
            mode === "authorization"
              ? () =>
                  Effect.fail(
                    new ProjectWorkAuthorizationError({ reason: "agent-approval-required" }),
                  )
              : mode === "gateway"
                ? () =>
                    Effect.fail(
                      new Authorization.ProjectTeamAuthorizationError({ reason: "invalid-intent" }),
                    )
                : mode === "unknown-error"
                  ? () => Effect.die(Error("Private gateway failure"))
                  : undefined,
          );
          const before = yield* readCurrentState(fixture.f.sql, fixture.f.binding.projectId);
          const originalDurable = yield* fixture.durable;
          const intent =
            mode === "revision-conflict"
              ? { ...fixture.intent, expectedRevision: fixture.intent.expectedRevision + 1 }
              : fixture.intent;
          const result = yield* fixture
            .invoke("project_work_report", {
              intentJSON: json(intent),
            })
            .pipe(Effect.result);
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: {
              _tag: "PiManagedRuntimeError",
              code: mode === "unknown-error" ? "uncertain" : "unavailable",
            },
          });
          expect(fixture.writes).toHaveLength(1);
          expect(fixture.writes[0]?.[0]).toEqual(intent);
          expect(yield* readCurrentState(fixture.f.sql, fixture.f.binding.projectId)).toEqual(
            before,
          );
          expect(
            yield* fixture.f.sql`SELECT * FROM project_work_command_receipts
            WHERE command_id=${intent.commandId}`,
          ).toEqual([]);
          expect(yield* fixture.durable).toEqual(originalDurable);
        }),
      ),
    );

  for (const mode of ["cancellation", "revoked-authority"] as const)
    it.effect(`keeps ${mode} after invalid report decoding fatal`, () =>
      scoped(
        Effect.gen(function* () {
          const fixture = yield* reportInputFeedbackFixture();
          const { f } = fixture;
          const before = yield* readCurrentState(f.sql, f.binding.projectId);
          const originalDurable = yield* fixture.durable;
          const receipts = yield* f.sql`SELECT * FROM project_work_command_receipts`;
          const decoded = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const original = ProjectWorkTools.executePiProjectWorkBridgeTool;
          const decode = vi
            .spyOn(ProjectWorkTools, "executePiProjectWorkBridgeTool")
            .mockImplementation((input) =>
              original(input).pipe(
                Effect.tapError((error) =>
                  Effect.gen(function* () {
                    expect(error).toMatchObject({
                      _tag: "PiProjectWorkToolValidationError",
                      reason: "invalid-intent",
                    });
                    yield* Deferred.succeed(decoded, undefined);
                    yield* Deferred.await(release);
                  }),
                ),
              ),
            );
          yield* Effect.addFinalizer(() => Effect.sync(() => decode.mockRestore()));
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          const controller = new AbortController();
          const { type, ...missingType } = fixture.intent;
          expect(type).toBe("project-team.assignment.report");
          const pending = yield* fixture
            .invoke("project_work_report", { intentJSON: json(missingType) }, controller.signal)
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(decoded);
          if (mode === "cancellation") controller.abort();
          else
            yield* restoreHistoricalBinding({
              ...f.binding,
              revision: f.binding.revision + 1,
              status: "revoked",
            });
          const current = yield* readCurrentState(f.sql, f.binding.projectId);
          yield* Deferred.succeed(release, undefined);
          const result = yield* Fiber.join(pending);
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "PiManagedRuntimeError" },
          });
          if (result._tag === "Failure")
            expect(mode === "cancellation" ? ["uncertain"] : ["unavailable", "denied"]).toContain(
              result.failure.code,
            );
          expect(fixture.reads).toBe(0);
          expect(fixture.writes).toEqual([]);
          expect(yield* readCurrentState(f.sql, f.binding.projectId)).toEqual(current);
          if (mode === "cancellation") expect(current).toEqual(before);
          expect(yield* f.sql`SELECT * FROM project_work_command_receipts`).toEqual(receipts);
          expect(yield* fixture.durable).toEqual(originalDurable);
        }),
      ),
    );
});

for (const outcome of ["findings", "complete"] as const)
  it.effect(`retains committed ${outcome} reports across the return fence`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* requiredTransferFixture(
          false,
          false,
          undefined,
          false,
          "project",
          "Retain the assignment report",
          {
            ...basicRuntimeProfile,
            roleTools: ["project-work.report"],
            toolIds: ["project-work.report"],
            deliverableKind: "non-code",
          },
        );
        yield* initializeRequiredContext(f);
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
          {
            threadId: f.binding.threadId,
            kind: "prompt",
            operationId: f.request.assignmentOperationId,
            prompt: f.request.assignment,
          },
          () => Effect.void,
        );
        if (!session) return yield* Effect.die("No controlled session captured");
        const captured = session;
        const before = yield* readCurrentState(f.sql, f.binding.projectId);
        const task = before.tasks.find((entry) => entry.taskId === f.binding.taskId)!;
        const assignment = before.foundationRecords!.find(
          (record) => record.kind === "task-membership" && record.taskId === task.taskId,
        )!;
        expect(assignment).toMatchObject({ kind: "task-membership", deliverableKind: "non-code" });
        const reportTool = captured.bootstrap.allowedTools.find(
          (tool) => tool.name === "project_work_report",
        );
        if (!reportTool) return yield* Effect.die("Current report tool was not passed to Pi");
        expect(
          captured.bootstrap.allowedTools
            .filter((tool) => tool.execution === "bridge")
            .map((tool) => tool.name),
        ).toEqual(["project_work_report"]);
        const reportSchema = captured.transferTexts.find(
          (entry) => entry.transferId === reportTool.name,
        )?.text;
        if (reportSchema === undefined)
          return yield* Effect.die("Current report schema was not passed to Pi");
        const parsedReportSchema = decodeNativeJsonEvidence(reportSchema);
        const templateDescription = reportTemplateDescription(parsedReportSchema);
        if (!templateDescription)
          return yield* Effect.die("Report intent template was not passed to Pi");
        expect(reportTool.description).toContain(
          "Do not claim verification that was not performed",
        );
        const template = decodeReportTemplate(templateDescription);
        if (template?.type !== "project-team.assignment.report")
          return yield* Effect.die("Transferred report template was invalid");
        expect(template).toMatchObject({
          projectId: task.projectId,
          taskId: task.taskId,
          commandId: captured.operation.operationId,
          expectedRevision: before.revision,
          expectedTaskRevision: task.revision,
          specRevision: task.specRevision,
          planRevision: f.binding.planRevision,
          assignmentId: assignment.recordId,
          expectedAssignmentRevision: assignment.revision,
          summary: "<summary>",
          evidenceIds: [],
          outputArtifactIds: [],
          outcome: "findings",
        });
        const intent = {
          ...template,
          summary: "The retained source supports the non-code deliverable",
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
              argvAttempts: f.allocations,
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
        expect(processes.filter((entry) => entry.owner_json === null)).toHaveLength(1);
        expect(returned._tag).toBe(outcome === "complete" ? "Failure" : "Success");
        if (returned._tag === "Success")
          expect(returned.success).toEqual({
            kind: "text",
            text: String(receipts[0]!.result_json),
          });
      }),
    ),
  );
it.effect("startup discovery admits only the original fresh setup without allocating", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* dispatchedRuntimeFixture();
      const read = f.instance.readSessionForStart;
      if (!read) return yield* Effect.die("Production runtime has no startup discovery");
      expect(yield* read(threadId)).toEqual({ kind: "fresh" });
      const adapter = yield* makePiAdapter({ instanceId: providerInstanceId, runtime: f.instance });
      yield* rejected(
        adapter.startSession({
          threadId,
          runtimeMode: "approval-required",
          resumeCursor: { sessionId: "unretained-native" },
        }),
      );
      expect(f.allocations).toBe(0);
      expect(f.transports).toBe(0);
      expect(yield* f.sql`SELECT * FROM project_team_pi_operation`).toEqual([]);
      expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
    }),
  ),
);

it.effect("startup discovery denies an unqualified reserved binding without allocating", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const read = f.instance.readSessionForStart;
      if (!read) return yield* Effect.die("Production runtime has no startup discovery");
      yield* rejected(read(threadId));
      expect(yield* f.sql`SELECT * FROM project_team_pi_operation`).toEqual([]);
      expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
      expect(f.launches).toBe(0);
      expect(f.transports).toBe(0);
    }),
  ),
);

it.effect("startup discovery rechecks changed authority before restoring an existing session", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* settledNativeForRead(f);
      const before = yield* f.sql`SELECT * FROM project_team_pi_operation`;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const makeOperations = PiOperations.makeProjectTeamPiOperations;
      const spy = vi
        .spyOn(PiOperations, "makeProjectTeamPiOperations")
        .mockImplementation((options) =>
          makeOperations(options).pipe(
            Effect.map((operations) => ({
              ...operations,
              sessionForStart: (identity) =>
                Effect.gen(function* () {
                  const state = yield* operations.sessionForStart(identity);
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  return state;
                }),
            })),
          ),
        );
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      const runtime = yield* makePiManagedRuntimeLive(f.options);
      const instance = yield* runtime.forInstance({
        instanceId: providerInstanceId,
        enabled: true,
        configuration: {},
      });
      const adapter = yield* makePiAdapter({ instanceId: providerInstanceId, runtime: instance });
      const starting = yield* adapter
        .startSession({ threadId, runtimeMode: "approval-required" })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.raceFirst(
        Deferred.await(entered),
        Fiber.join(starting).pipe(
          Effect.andThen(Effect.die("Startup ended before current authority could be changed")),
        ),
      );
      yield* restoreHistoricalBinding({
        ...f.binding,
        revision: f.binding.revision + 1,
        status: "revoked",
      });
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(starting))._tag).toBe("Failure");
      expect(yield* adapter.listSessions()).toEqual([]);
      expect(yield* f.sql`SELECT * FROM project_team_pi_operation`).toEqual(before);
      expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
      expect(f.launches).toBe(0);
      expect(f.transports).toBe(0);
    }),
  ),
);

it.effect("managed ProviderService restores a replacement adapter without a caller cursor", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const native = yield* settledNativeForRead(f);
      const before = yield* f.sql`SELECT * FROM project_team_pi_operation`;
      const provider = ProviderDriverKind.make("piAgent");
      const oldScope = yield* Scope.make();
      let adapter = yield* makePiAdapter({
        instanceId: providerInstanceId,
        runtime: f.instance,
        resolveOperationId: () =>
          Effect.fail(
            new PiManagedRuntimeError({
              code: "denied",
              detail: "No new initialization is authorized",
            }),
          ),
      }).pipe(Scope.provide(oldScope));
      yield* adapter.startSession({
        threadId,
        runtimeMode: "approval-required",
        resumeCursor: native,
      });
      const changes = yield* PubSub.unbounded<void>();
      const application = {
        threadId,
        providerInstanceId,
        desiredRevision: SkillCatalogRevision.make(1),
        appliedRevision: SkillCatalogRevision.make(0),
        status: "pending_new_session" as const,
        outcomes: [],
      };
      const services = yield* Layer.build(
        makeProviderServiceLive().pipe(
          // Empty authored skill state; runtime/session/SQL admission below are real.
          Layer.provide(
            Layer.mock(SkillCatalogService)({
              describeSession: () => Effect.succeed(application),
              prepareSession: () => Effect.succeed({ application }),
              disposeSession: () => Effect.void,
            }),
          ),
          Layer.provide(
            Layer.mock(ProjectionSnapshotQuery)({
              getCommandReadModel: () => Effect.succeed(createEmptyReadModel(at)),
              getThreadShellById: () => Effect.succeed(Option.none()),
            }),
          ),
          Layer.provide(
            Layer.mock(OrchestrationEngineService)({
              dispatch: () => Effect.succeed({ sequence: 0 }),
            }),
          ),
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry, {
              getByInstance: () => Effect.suspend(() => Effect.succeed(adapter)),
              getInstanceInfo: () =>
                Effect.succeed({
                  instanceId: providerInstanceId,
                  driverKind: provider,
                  displayName: undefined,
                  enabled: true,
                  continuationIdentity: {
                    driverKind: provider,
                    continuationKey: "startup-fixture",
                  },
                }),
              listInstances: () => Effect.succeed([providerInstanceId]),
              subscribeChanges: PubSub.subscribe(changes),
            }),
          ),
          Layer.provide(
            ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntime.layer)),
          ),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pi-startup-service-" })),
        ),
      );
      const service = Context.get(services, ProviderService);
      const request = {
        input: {
          threadId,
          providerInstanceId,
          runtimeMode: "approval-required" as const,
          cwd: f.worktree,
          modelSelection: { instanceId: providerInstanceId, model },
        },
        primaryProjectRoot: f.main,
        assertCurrent: f.instance.readSession(threadId).pipe(
          Effect.mapError(
            (error) =>
              new ProviderValidationError({
                operation: "startupFixture.current",
                issue: error.code,
              }),
          ),
          Effect.asVoid,
        ),
      };
      const original = yield* startManagedProviderSession(service, request);
      yield* Scope.close(oldScope, Exit.void);
      adapter = yield* makePiAdapter({
        instanceId: providerInstanceId,
        runtime: f.instance,
        resolveOperationId: () =>
          Effect.fail(
            new PiManagedRuntimeError({
              code: "denied",
              detail: "Replacement cannot reinitialize",
            }),
          ),
      });
      expect(yield* startManagedProviderSession(service, request)).toEqual(original);
      expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual(native);
      expect(yield* f.sql`SELECT * FROM project_team_pi_operation`).toEqual(before);
      expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
      expect(f.launches).toBe(0);
      expect(f.transports).toBe(0);
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
        const readStart = f.instance.readSessionForStart;
        if (!readStart) return yield* Effect.die("Production runtime has no startup discovery");
        expect(yield* readStart(threadId)).toMatchObject({
          kind: "existing",
          session: { resumeCursor: native },
        });
        yield* f.sql`UPDATE project_team_pi_operation SET intent_json=json_set(intent_json, '$.resourceHash', ${"a".repeat(64)})`;
        yield* rejected(f.instance.readSession(threadId));
        yield* rejected(readStart(threadId));
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
        const readStart = f.instance.readSessionForStart;
        if (!readStart) return yield* Effect.die("Production runtime has no startup discovery");
        expect(yield* readStart(threadId, f.plan)).toMatchObject({
          kind: "existing",
          session: { resumeCursor: native },
        });
        expect(yield* f.fs.readDirectory(f.cache)).toEqual([]);
        const badPlan = structuredClone(f.plan);
        Object.assign(badPlan, { desiredRevision: -1 });
        yield* rejected(f.instance.readSession(threadId, badPlan));
        yield* rejected(readStart(threadId, badPlan));
        yield* f.fs.writeFileString(f.skill.packagePath + "/SKILL.md", "Changed selected source");
        yield* rejected(f.instance.readSession(threadId, f.plan));
        yield* rejected(readStart(threadId, f.plan));
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
      const f = yield* dispatchedRuntimeFixture({
        ...basicRuntimeProfile,
        roleSkillIds: ["role-only-uninstalled"],
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
        { threadId, kind: "initialize", operationId: f.request.initializeOperationId },
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
      const f = yield* selectedRuntimeFixture(true);
      const preparation = f.instance.prepareOperation(
        {
          threadId,
          kind: "initialize",
          operationId: f.originalInitializeOperationId(),
          skillPlan: f.plan,
        },
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
        const f = yield* selectedRuntimeFixture(true);
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
          .prepareOperation(
            {
              threadId,
              kind: "initialize",
              operationId: f.originalInitializeOperationId(),
              skillPlan: f.plan,
            },
            () => Effect.void,
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* rejected(
          instance.prepareOperation(
            {
              threadId,
              kind: "initialize",
              operationId: f.originalInitializeOperationId(),
              skillPlan: f.plan,
            },
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
        const f = yield* selectedRuntimeFixture(true);
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
          .prepareOperation(
            {
              threadId,
              kind: "initialize",
              operationId: f.originalInitializeOperationId(),
              skillPlan: f.plan,
            },
            () => Effect.void,
          )
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
      const f = yield* selectedRuntimeFixture(true);
      const pending = f.instance.prepareOperation(
        {
          threadId,
          kind: "initialize",
          operationId: f.originalInitializeOperationId(),
          skillPlan: f.plan,
        },
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
      const before = yield* f.sql`SELECT * FROM project_team_model_budget`;
      yield* rejected(
        f.instance.prepareOperation(
          {
            threadId,
            kind: "initialize",
            operationId: f.originalInitializeOperationId(),
            skillPlan: f.plan,
          },
          () => Effect.void,
        ),
      );
      expect(operations[0]?.operation_id).toBe(first.operation.operationId);
      expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toEqual(before);
      expect(yield* f.sql`SELECT unit FROM project_team_pi_process`).toHaveLength(1);
      yield* f.instance.stopAll;
    }),
  ).pipe(Effect.provide(selectedRuntimeLayer)),
);
for (const mode of ["explicit-stop", "scope-close"] as const) {
  it.effect("selected prepared resource cleanup " + mode, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* selectedRuntimeFixture(true);
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
              {
                threadId,
                kind: "initialize",
                operationId: f.originalInitializeOperationId(),
                skillPlan: f.plan,
              },
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
        const f = yield* selectedRuntimeFixture(true);
        let fail = false;
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
              {
                threadId,
                kind: "initialize",
                operationId: f.originalInitializeOperationId(),
                skillPlan: f.plan,
              },
              () => Effect.void,
            );
            fail = true;
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
      const f = yield* selectedRuntimeFixture(true);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const observedSql = new Proxy(f.sql, {
        apply(target, _receiver, args) {
          const statement = target(args[0], ...args.slice(1));
          if (!Array.isArray(args[0]) || !Object.hasOwn(args[0], "raw")) return statement;
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
              {
                threadId,
                kind: "initialize",
                operationId: f.originalInitializeOperationId(),
                skillPlan: f.plan,
              },
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

const genuineReplayFixture = Effect.fn("genuineReplayFixture")(function* (prompt = false) {
  const f = yield* requiredTransferFixture(
    false,
    false,
    undefined,
    false,
    "project",
    "Investigate current assignment",
    basicRuntimeProfile,
  );
  yield* initializeRequiredContext(f, prompt);
  const request: PiManagedOperationRequest = prompt
    ? {
        threadId: f.binding.threadId,
        kind: "prompt",
        operationId: f.request.assignmentOperationId,
        prompt: f.request.assignment,
      }
    : {
        threadId: f.binding.threadId,
        kind: "initialize",
        operationId: f.request.initializeOperationId,
      };
  const operations = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
  const op = yield* operations.lookup(
    { providerInstanceId, threadId: f.binding.threadId },
    request,
    NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(request)).digest("hex"),
    piManagedSkillResourceIdentity([]),
  );
  if (!op) return yield* Effect.die("Missing genuine original replay receipt");
  const nativeFile = op.nativeState.path + "/" + op.native.sessionReference;
  const bytes = yield* f.fs.readFileString(nativeFile);
  const argvBaseline = f.allocations;
  const budget = yield* f.sql`SELECT * FROM project_team_model_budget`;
  const assertUnusedAssignmentAuthority = Effect.gen(function* () {
    const authority = yield* operations.current({
      providerInstanceId,
      threadId: f.binding.threadId,
    });
    expect(authority.binding.recordId).toBe(f.binding.recordId);
    expect(authority.binding.status).toBe("running");
    expect(authority.state.tasks.find((task) => task.taskId === f.binding.taskId)?.state).not.toBe(
      "canceled",
    );
    expect(
      authority.state.foundationRecords?.find(
        (record) => record.kind === "task-membership" && record.taskId === f.binding.taskId,
      ),
    ).toMatchObject({ status: "active", controlState: "active" });
    expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toEqual(budget);
    expect(
      yield* f.sql`SELECT operation_id FROM project_team_pi_operation WHERE operation_id=${f.request.assignmentOperationId}`,
    ).toEqual([]);
  });
  return {
    ...f,
    request,
    op,
    terminal: op.terminal,
    nativeFile,
    bytes,
    assertUnusedAssignmentAuthority,
    assignmentRequest: {
      threadId: f.binding.threadId,
      kind: "prompt" as const,
      operationId: f.request.assignmentOperationId,
      prompt: f.request.assignment,
    },
    get launches() {
      return f.allocations - argvBaseline;
    },
    get transports() {
      return f.transports;
    },
  };
});

// Historical denial fixtures retain synthetic metadata and use the real SQL/file reader.
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
        const f = yield* mode === "prompt-restart"
          ? genuineReplayFixture(true)
          : stableReplayFixtureFor();
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
        const f = yield* genuineReplayFixture();
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
        const nextRequest = f.assignmentRequest;
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
          yield* f.assertUnusedAssignmentAuthority;
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
        const f = yield* genuineReplayFixture();
        const original =
          yield* f.sql`SELECT * FROM project_team_pi_operation WHERE operation_id=${f.op.operation.operationId}`;
        let instance: PiManagedRuntimeInstance | undefined;
        let armed = false;
        const observedSql = new Proxy(f.sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            if (!Array.isArray(args[0]) || !Object.hasOwn(args[0], "raw")) return statement;
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
        yield* f.assertUnusedAssignmentAuthority;
        const next = yield* instance
          .prepareOperation(f.assignmentRequest, () => Effect.void)
          .pipe(Effect.provideService(SqlClient.SqlClient, observedSql));
        expect(next.operation.operationId).toBe(f.assignmentRequest.operationId);
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
        const f = yield* requiredReviewTransferFixture();
        const originalRequired = yield* f.reader.readForOperation({
          projectId: f.binding.projectId,
          bindingId: f.binding.recordId,
          generation: f.binding.generation,
          providerInstanceId,
          threadId: f.binding.threadId,
          operationId: f.request.initializeOperationId,
          operationKind: "initialize",
        });
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
                    expect(briefing).toContain(originalRequired.text);
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
          {
            threadId: f.binding.threadId,
            kind: "initialize",
            operationId: f.request.initializeOperationId,
          },
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
            {
              threadId: f.binding.threadId,
              kind: "initialize",
              operationId: f.request.initializeOperationId,
            },
            () => Effect.void,
          );
          expect((yield* replay.run).terminal.outcome).toBe("success");
          if (mode === "fresh-prompt") {
            const journal = yield* makeProjectTeamDispatchJournal({
              environmentId: "environment",
              maximumEnvironmentModelCalls: 4,
              verifyStage: (receipt, original) =>
                receipt.evidence.bindingId === original.intent.request.git.runId &&
                receipt.evidence.setupId === original.intent.request.setupId
                  ? Effect.void
                  : Effect.fail(
                      new ProjectTeamDispatchJournalError({
                        reason: "Foreign controlled fresh review stage",
                      }),
                    ),
            });
            let snapshot = yield* journal.readRetained(f.request.dispatchId);
            for (const stage of [
              "workspace-ready",
              "setup-complete",
              "session-bound",
              "assignment-intent",
            ] as const)
              snapshot = yield* journal.readRetained(
                (yield* journal.advanceStage(snapshot.fence, {
                  receiptId: `fresh-review-${stage}`,
                  stage,
                  evidence: { bindingId: f.binding.recordId, setupId: f.request.setupId },
                })).fence.dispatchId,
              );
            const assignment = yield* instance.prepareOperation(
              {
                threadId: f.binding.threadId,
                kind: "prompt",
                operationId: f.request.assignmentOperationId,
                prompt: f.request.assignment,
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
                {
                  threadId: f.binding.threadId,
                  kind: "initialize",
                  operationId: f.request.initializeOperationId,
                },
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
const decodeMemoryRecoveryIdentity = Schema.decodeUnknownEffect(ProjectMemoryOperationIdentity);
const isMemoryRecoveryError = Schema.is(ProjectMemoryServiceError);
const decodeRequiredJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeQueryRecoverySettlement = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProjectMemorySettlement),
  { onExcessProperty: "error" },
);
const decodeMemoryLedgerOwner = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectMemoryJobOwner),
);
const decodeMemoryCompanionInput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({
        protocolVersion: Schema.Literal(1),
        requestId: Schema.String,
        operation: Schema.Literals(["index", "reconcile"]),
        input: MemoryIndexManifest,
      }),
      Schema.Struct({
        protocolVersion: Schema.Literal(1),
        requestId: Schema.String,
        operation: Schema.Literal("delete-source"),
        input: MemoryBackendSource,
      }),
    ]),
  ),
  { onExcessProperty: "error" },
);
const decodeSharedQuerySources = Schema.decodeUnknownEffect(ProjectTeamMemorySharedSourcesRead);
const decodeSharedQueryShares = Schema.decodeUnknownEffect(ProjectTeamMemorySharesReplaceIntent);
const decodeQueryCompanionInput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      protocolVersion: Schema.Literal(1),
      requestId: Schema.String,
      operation: Schema.Literal("search"),
      input: MemoryBackendSearch,
    }),
  ),
  { onExcessProperty: "error" },
);

// Default required-context cases control session execution; the opt-in native case uses the real owner and worker.
const reviewFixtureEpoch = at;
const requiredReviewTransferFixture = Effect.fn("requiredReviewTransferFixture")(function* (
  native = false,
  verificationAssets?: PiProductionRuntimeAssets,
) {
  const at = native ? DateTime.formatIso(DateTime.nowUnsafe()) : reviewFixtureEpoch;
  const shiftSeedDates = <A>(input: A): A => {
    const cloned = structuredClone(input);
    const visit = (value: unknown) => {
      if (value === null || typeof value !== "object") return;
      for (const key of Object.keys(value)) {
        const entry: unknown = Reflect.get(value, key);
        if (typeof entry === "string" && /^2026-01-01T[0-9:.]+Z$/.test(entry))
          Reflect.set(
            value,
            key,
            DateTime.formatIso(
              DateTime.makeUnsafe(
                Date.parse(entry) + Date.parse(at) - Date.parse(reviewFixtureEpoch),
              ),
            ),
          );
        else visit(entry);
      }
    };
    if (native) visit(cloned);
    return cloned;
  };
  // This container maps the installed Git binary's root owner to nobody. Keep
  // physical Git execution and all workspace checks; normalize only that host UID.
  const hostFs = process.getBuiltinModule("fs");
  const originalLstat = hostFs.lstatSync;
  const gitOwnership = vi.spyOn(hostFs, "lstatSync").mockImplementation((...args) => {
    const stat = originalLstat(...args);
    if (args[0] === "/usr/bin/git" && stat?.uid === 65534n)
      Object.defineProperty(stat, "uid", { value: 0n });
    return stat;
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => gitOwnership.mockRestore()));
  const capturedSql = yield* SqlClient.SqlClient;
  const physicalServices = yield* Effect.context<
    FileSystem.FileSystem | import("effect/Path").Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const physicalFs = yield* FileSystem.FileSystem;
  const nativeScratch = native ? process.env.PI_REVIEW_TARGET_NATIVE_SCRATCH : undefined;
  if (nativeScratch) yield* physicalFs.makeDirectory(nativeScratch, { recursive: true });
  const physicalRoot = yield* physicalFs.makeTempDirectoryScoped(
    nativeScratch ? { directory: nativeScratch } : undefined,
  );
  const implementationMain = physicalRoot + "/implementation-main";
  const implementationWorktree = physicalRoot + "/implementation-worktree";
  const physicalGit = (cwd: string, args: ReadonlyArray<string>) =>
    Effect.sync(() =>
      process
        .getBuiltinModule("child_process")
        .execFileSync("/usr/bin/git", ["-C", cwd, ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        })
        .trim(),
    );
  yield* physicalFs.makeDirectory(implementationMain);
  yield* physicalGit(implementationMain, ["init", "-qb", "main"]);
  yield* physicalFs.writeFileString(implementationMain + "/README.md", "base README\n");
  yield* physicalGit(implementationMain, ["add", "."]);
  yield* physicalGit(implementationMain, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "base",
  ]);
  const implementationBase = yield* physicalGit(implementationMain, ["rev-parse", "HEAD"]);
  let implementationReceipt: typeof DispatchJournal.ProjectTeamWorkspaceReceipt.Type | undefined;
  const originalJournal = DispatchJournal.makeProjectTeamDispatchJournal;
  // Correct the historical fixture producer before its first durable claim, then sequence
  // controlled setup receipts before settlement. No native setup worker is launched.
  const fixtureSpy = vi
    .spyOn(DispatchJournal, "makeProjectTeamDispatchJournal")
    .mockImplementation((options) => {
      const { prepareReviewCompletion, prepareFailure, verifyReviewTarget, ...fixtureOptions } =
        options;
      if (
        prepareReviewCompletion !== undefined ||
        prepareFailure !== undefined ||
        verifyReviewTarget !== undefined
      )
        throw Error("Original root fixture unexpectedly supplied review callbacks");
      return originalJournal(fixtureOptions).pipe(
        Effect.map((journal) => ({
          ...journal,
          reserve: (request) =>
            Effect.gen(function* () {
              const transition = request.claim.transition;
              if (transition?.kind !== "claim")
                return yield* Effect.die("Missing original root claim");
              const state = yield* readCurrentState(capturedSql, request.claim.projectId);
              const role = state.foundationRecords?.find(
                (record) =>
                  record.kind === "role-revision" &&
                  record.recordId === transition.binding.roleRevisionId,
              );
              if (role?.kind !== "role-revision")
                return yield* Effect.die("Missing original root role");
              const physicalAssignment = {
                ...request.git,
                primaryRoot: implementationMain,
                commonGitDirectory: implementationMain + "/.git",
                worktreePath: implementationWorktree,
                baseOid: implementationBase,
              };
              Object.assign(request.git, physicalAssignment);
              Object.assign(transition.binding, {
                worktree: implementationWorktree,
                branch: physicalAssignment.branchRef,
              });
              if (!implementationReceipt) {
                const managed = yield* ManagedGit.make({
                  assignment: physicalAssignment,
                  revalidate: Effect.void,
                  persistWorkspace: (receipt) =>
                    Effect.sync(() => {
                      implementationReceipt = receipt;
                    }),
                });
                yield* ManagedGit.createManagedWorktree(managed, {
                  cwd: implementationMain,
                  path: implementationWorktree,
                  refName: physicalAssignment.baseRef,
                  newRefName: physicalAssignment.branchRef.slice(11),
                });
                yield* physicalFs.writeFileString(
                  implementationWorktree + "/README.md",
                  "implemented README\n",
                );
                yield* physicalFs.writeFileString(
                  implementationWorktree + "/space name.txt",
                  "verified spaced name\n",
                );
                yield* physicalFs.writeFileString(
                  implementationWorktree + "/greeting.js",
                  "export const greeting = 'hello';\n",
                );
                yield* physicalFs.writeFileString(
                  implementationWorktree + "/greeting.test.js",
                  "import { greeting } from './greeting.js';\nif (greeting !== 'hello') throw Error('wrong greeting');\n",
                );
                yield* physicalGit(implementationWorktree, ["add", "."]);
                yield* physicalGit(implementationWorktree, [
                  "-c",
                  "user.name=Fixture",
                  "-c",
                  "user.email=fixture@example.test",
                  "commit",
                  "-qm",
                  "implementation",
                ]);
              }
              return yield* journal.reserve({
                ...request,
                claim: {
                  ...request.claim,
                  transition: {
                    ...transition,
                    binding: {
                      ...transition.binding,
                      configuration: {
                        ...transition.binding.configuration,
                        ...(native ? { maxTokens: 64000, maxDurationMs: 300000 } : {}),
                        instructionsHash: NodeCrypto.createHash("sha256")
                          .update(role.instructions)
                          .digest("hex"),
                      },
                    },
                  },
                },
              });
            }).pipe(
              Effect.provide(physicalServices),
              Effect.mapError(
                () =>
                  new ProjectTeamDispatchJournalError({
                    reason: "Physical fixture reservation failed",
                  }),
              ),
            ),
          settleAfterJoined: (expected, receipt) =>
            Effect.gen(function* () {
              let snapshot = yield* journal.readRetained(expected.dispatchId);
              const state = yield* readCurrentState(
                capturedSql,
                snapshot.intent.compiledClaim.projectId,
              );
              expect(
                state.foundationRecords?.filter(
                  (record) =>
                    record.kind === "effect" &&
                    record.effectKind === "setup" &&
                    record.runId === snapshot.intent.request.git.runId,
                ),
              ).toEqual([]);
              const sequenced = yield* originalJournal({
                ...fixtureOptions,
                verifyStage: (stage, original) =>
                  stage.evidence.bindingId === original.intent.request.git.runId &&
                  stage.evidence.setupId === original.intent.request.setupId
                    ? Effect.void
                    : Effect.fail(
                        new ProjectTeamDispatchJournalError({
                          reason: "Foreign controlled root setup",
                        }),
                      ),
              });
              for (const stage of ["workspace-ready", "setup-complete"] as const) {
                snapshot = yield* sequenced.readRetained(
                  (yield* sequenced.advanceStage(snapshot.fence, {
                    receiptId: `required-root-${stage}`,
                    stage,
                    evidence: {
                      bindingId: snapshot.intent.request.git.runId,
                      setupId: snapshot.intent.request.setupId,
                    },
                  })).fence.dispatchId,
                );
              }
              return yield* journal.settleAfterJoined(snapshot.fence, receipt);
            }),
        })),
      );
    });
  const physicalVerificationFixture = Effect.gen(function* () {
    const repository = yield* ProjectWorkRepository;
    const sql = capturedSql;
    const key = (id: string) => id;
    let pending: typeof ProjectWorkFoundationCommitCommand.Type | undefined;
    yield* seed("implementer", "reserved", {
      roleTools: ["pi.read", "pi.write"],
      toolIds: ["pi.read", "pi.write"],
      issueCredential: false,
    }).pipe(
      Effect.provideService(ProjectWorkRepository, {
        ...repository,
        execute: (rawCommand) => {
          const command = shiftSeedDates(rawCommand);
          if (
            command.type === "project-work.foundation.commit" &&
            command.transition?.kind === "claim"
          ) {
            pending = command;
            return Effect.fail(
              new ProjectWorkPolicyError("invalid-state", "Retain physical claim"),
            );
          }
          return repository.execute(command);
        },
      }),
      Effect.result,
    );
    if (!pending || pending.transition?.kind !== "claim")
      return yield* Effect.die("Missing physical claim");
    yield* repository.execute(
      yield* decodeRequiredFoundation({
        type: "project-work.foundation.commit",
        projectId,
        commandId: "configure-limits",
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
            modelCalls: native ? 12 : 2,
            delegationDepth: 2,
            repairAllowance: 2,
            model: "test",
            tokenLimit: native ? 128000 : 2000,
            durationLimitMs: native ? 300000 : 2000,
          },
        ],
      }),
    );
    yield* TestClock.setTime(Date.parse(at) + 1);
    const claim = {
      ...pending,
      expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
      transition: {
        ...pending.transition,
        binding: {
          ...pending.transition.binding,
          branch: key("refs/heads/assigned"),
          worktree: key("/workspace-assigned"),
        },
      },
    };
    const request: DispatchJournal.ProjectTeamDispatchRequest = {
      dispatchId: key("dispatch-intent"),
      claim,
      git: {
        effectId: key("dispatch-intent"),
        runId: key("binding"),
        generation: 0,
        primaryRoot: "/workspace",
        commonGitDirectory: "/workspace/.git",
        worktreePath: key("/workspace-assigned"),
        branchRef: key("refs/heads/assigned"),
        baseRef: "refs/heads/main",
        baseOid: "a".repeat(40),
        ownershipToken: "owner",
        policyHash: "b".repeat(64),
      },
      setupId: key("setup"),
      initializeOperationId: key("initialize"),
      assignmentOperationId: key("assignment"),
      assignment: "Implement the approved task",
    };
    const journal = yield* makeProjectTeamDispatchJournal({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
    });
    const f = { sql, repository, request, journal };
    const claimed = yield* journal.claimEffect((yield* journal.reserve(request)).fence);
    const settling = yield* makeProjectTeamDispatchJournal({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
      verifyStage: () => Effect.void,
      verifySettlement: () => Effect.void,
    });
    const snapshot = yield* settling.settleAfterJoined(claimed.fence, {
      receiptId: "prepared-joined",
      stage: "settled",
      evidence: { worker: "joined", setup: "joined", transport: "drained" },
    });
    if (!implementationReceipt) return yield* Effect.die("Missing physical workspace receipt");
    const receipt = implementationReceipt;
    yield* sql`INSERT INTO project_team_workspace_receipt VALUES (${request.dispatchId},'environment','binding',0,${snapshot.fence.claimGeneration},${canonicalProjectWorkPayload(receipt.assignment)},${encodeFixtureWorkspaceReceipt(receipt)})`;
    const state = yield* readCurrentState(f.sql, projectId);
    const binding = state.foundationRecords?.find(
      (r) => r.kind === "run-binding" && r.recordId === key("binding"),
    );
    if (binding?.kind !== "run-binding") return yield* Effect.die("Missing settled binding");
    const selectedTask = state.tasks.find((t) => t.taskId === binding.taskId);
    if (!selectedTask) return yield* Effect.die("Missing current task");
    const selection = yield* decodeNativeVerificationSelection({
      jobId: key("verification-1"),
      projectId,
      taskId: selectedTask.taskId,
      expectedRevision: state.revision,
      expectedTaskRevision: selectedTask.revision,
      specRevision: selectedTask.specRevision,
      planRevision: binding.planRevision,
      bindingId: binding.recordId,
      expectedBindingRevision: binding.revision,
      generation: binding.generation,
      criterionIds: state.criteria
        .filter((c) => c.taskId === selectedTask.taskId)
        .map((c) => c.criterionId),
      command: {
        executable: verificationAssets ? "/runtime/node" : "/bin/bash",
        argv: verificationAssets ? ["greeting.test.js"] : ["-n", "test.sh"],
        environment: "clean",
        limits: { maxDurationMs: verificationAssets ? 20000 : 1000, maxOutputBytes: 4096 },
      },
    });
    const jobs = yield* makeProjectWorkVerificationJobs({ environmentId: "environment" });
    const preparation = yield* VerificationPreparation.makeProjectWorkVerificationPreparation({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 4,
      assertHumanCurrent: () => Effect.void,
      captureWorkspace: (original, use) =>
        Effect.gen(function* () {
          const managed = yield* ManagedGit.make({
            assignment: original.receipt.assignment,
            priorReceipt: original.receipt,
            revalidate: Effect.void,
            persistWorkspace: () => Effect.die("Cannot recreate verification workspace"),
          });
          return yield* ManagedGit.withManagedVerificationTarget(managed, use);
        }).pipe(
          Effect.provide(physicalServices),
          Effect.mapError(
            () =>
              new ProjectWorkVerificationPreparationError({
                reason: "Physical verification target changed",
              }),
          ),
        ),
      captureExecutable: (_binding, command, use) =>
        verificationAssets
          ? withProjectWorkVerificationExecutable(verificationAssets, command.executable, use).pipe(
              Effect.mapError(
                () =>
                  new ProjectWorkVerificationPreparationError({
                    reason: "Actual native verification closure changed",
                  }),
              ),
            )
          : use({
              executableTarget: command.executable,
              sha256: "e".repeat(64),
              runtimeClosureSha256: "f".repeat(64),
            }),
      retainPrepared: (manifest) =>
        jobs.retainPrepared(manifest).pipe(
          Effect.mapError(
            () =>
              new ProjectWorkVerificationPreparationError({
                reason: "Physical fixture retention failed",
              }),
          ),
        ),
    });
    const principal = { actor: { kind: "human" as const, id: "maintainer" } };
    const prepared = yield* preparation.prepare(selection, principal);
    return { ...f, state, snapshot, receipt, selection, jobs, preparation, principal, prepared };
  });
  const f = yield* physicalVerificationFixture.pipe(
    Effect.ensuring(Effect.sync(() => fixtureSpy.mockRestore())),
  );
  const rootClaim = f.snapshot.intent.compiledClaim.transition;
  if (rootClaim?.kind !== "claim") return yield* Effect.die("Missing captured root claim");
  const rootRole = (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
    (record) =>
      record.kind === "role-revision" && record.recordId === rootClaim.binding.roleRevisionId,
  );
  if (rootRole?.kind !== "role-revision") return yield* Effect.die("Missing captured root role");
  expect(rootClaim.binding.configuration.instructionsHash).toBe(
    NodeCrypto.createHash("sha256").update(rootRole.instructions).digest("hex"),
  );
  expect(
    (yield* f.journal.readStageReceipts(f.request.dispatchId)).map((receipt) => receipt.stage),
  ).toEqual(["workspace-ready", "setup-complete", "settled"]);
  const { sql, repository } = f;
  const auth = yield* Authorization.ProjectTeamAuthorization;
  const gates = yield* makeProjectWorkVerificationGate({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
  });
  const human = {
    actor: f.principal.actor,
    source: { kind: "web" as const, id: "required-review-human" },
    recordedAt: at,
  };
  const decodeIntent = Schema.decodeUnknownEffect(ProjectTeamWriteIntent);
  const trust = (selection: typeof f.selection) =>
    ProjectWorkVerificationApproval.of({
      selection,
      receipt: f.prepared,
      assertCurrent: (state, duplicate) =>
        gates
          .assertCurrent(state, f.prepared, selection, duplicate)
          .pipe(
            Effect.mapError(
              () =>
                new ProjectWorkVerificationGateError({ reason: "Required review target changed" }),
            ),
          ),
    });
  yield* repository.execute(
    yield* auth
      .intent(
        f.principal,
        yield* decodeIntent({
          ...f.selection,
          type: "project-team.verification.propose",
          commandId: "required-verification-propose",
        }),
        human,
        false,
      )
      .pipe(Effect.provideService(ProjectWorkVerificationApproval, trust(f.selection))),
  );
  let state = yield* readCurrentState(sql, projectId);
  const approval = state.foundationRecords?.find(
    (r) => r.kind === "gate" && r.verificationJobId === f.selection.jobId,
  );
  if (approval?.kind !== "gate")
    return yield* Effect.die("Missing required parent verification proposal");
  yield* repository.execute(
    yield* auth
      .intent(
        f.principal,
        yield* decodeIntent({
          type: "project-team.gate.respond",
          commandId: "required-verification-approve",
          projectId,
          taskId: f.selection.taskId,
          expectedRevision: state.revision,
          expectedTaskRevision: f.selection.expectedTaskRevision,
          specRevision: f.selection.specRevision,
          planRevision: f.selection.planRevision,
          gateId: approval.recordId,
          expectedGateRevision: approval.revision,
          response: "approved",
        }),
        human,
        false,
      )
      .pipe(
        Effect.provideService(
          ProjectWorkVerificationApproval,
          trust({ ...f.selection, expectedRevision: state.revision }),
        ),
        Effect.provideService(
          ProjectWorkVerificationRequest,
          ProjectWorkVerificationRequest.of({ assertCurrent: () => Effect.void }),
        ),
      ),
  );
  state = yield* readCurrentState(sql, projectId);
  const parent = state.tasks.find((task) => task.taskId === f.selection.taskId);
  const specGate = state.foundationRecords?.find(
    (r) => r.kind === "gate" && r.taskId === parent?.taskId && r.gate === "specification",
  );
  const planGate = state.foundationRecords?.find(
    (r) => r.kind === "gate" && r.taskId === parent?.taskId && r.gate === "plan",
  );
  const plan = state.foundationRecords?.find(
    (r) => r.kind === "plan-revision" && r.taskId === parent?.taskId,
  );
  if (
    !parent ||
    specGate?.kind !== "gate" ||
    planGate?.kind !== "gate" ||
    plan?.kind !== "plan-revision"
  )
    return yield* Effect.die("Missing approved review parent scope");
  yield* repository.execute(
    yield* decodeRequiredFoundation({
      type: "project-work.foundation.commit",
      projectId,
      commandId: "required-human-review",
      expectedRevision: state.revision,
      attribution: human,
      committedAt: at,
      records: [],
      guided: {
        intent: {
          type: "project-team.assignment.start",
          assignmentKind: "review",
          projectId,
          taskId: parent.taskId,
          commandId: "required-human-review",
          expectedRevision: state.revision,
          expectedTaskRevision: parent.revision,
          objective: "Review the original approved scope",
          outputDescriptions: ["Independent review findings"],
          specRevision: parent.specRevision,
          specificationGateId: specGate.recordId,
          expectedSpecificationGateRevision: specGate.revision,
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
  const task = state.tasks.find((task) => task.taskId !== parent.taskId);
  if (!task) return yield* Effect.die("Missing human review task");
  const gateway = yield* ProjectWorkGateway;
  yield* gateway.write(
    {
      type: "project-team.configure",
      commandId: CommandId.make("required-review-configure"),
      projectId,
      expectedRevision: state.revision,
      expectedConfigurationGeneration: 0,
      enabled: true,
      providerInstanceId,
      projectPriority: 1,
      taskPriorities: [],
      profiles: (
        ["coordinator", "investigator", "planner", "implementer", "reviewer", "integrator"] as const
      ).map((role) => ({
        role,
        instructions: `Required context for ${role}`,
        skills: [],
        tools:
          role === "implementer" || role === "integrator"
            ? ["pi.read", "pi.write"]
            : native && role === "reviewer"
              ? ["pi.read", "project-work.report"]
              : ["pi.read"],
        model,
        memoryAccess: "none",
        delegationDepth: 2,
      })),
      modelPolicies: [
        {
          model,
          tokenLimit: native ? 128000 : 2000,
          durationLimitMs: native ? 300000 : 2000,
          modelCalls: 2,
        },
      ],
      environmentModelCalls: 4,
      projectWritableWorkers: 2,
      delegationDepth: 2,
      repairAllowance: 2,
    },
    human.actor,
    human.source,
    f.principal,
  );
  const fs = yield* FileSystem.FileSystem;
  const scratch = yield* fs.makeTempDirectoryScoped(
    nativeScratch ? { directory: nativeScratch } : undefined,
  );
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
  yield* fs.writeFileString(main + "/README.md", "base README\n");
  yield* git(["-C", main, "add", "."]);
  yield* git([
    "-C",
    main,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "reviewer base",
  ]);
  const baseOid = yield* git(["-C", main, "rev-parse", "HEAD"]);
  yield* git(["-C", main, "worktree", "add", "-qb", "required-review", assigned]);
  const catalogue = {
    source: "https://api.commandcode.ai/provider/v1/models" as const,
    fetchedAt: at,
    selectedEntry: {
      id: "inclusionai/ling-3.1-flash:free" as const,
      owned_by: "command-code" as const,
      context_length: native ? 128000 : 20000,
      supported_endpoints: ["/chat/completions"],
    },
  };
  const prepared = prepareProjectTeamConfiguredAdmission({
    state: yield* readCurrentState(sql, projectId),
    taskId: task.taskId,
    nowMs: Date.parse(at) + 1,
    facts: {
      environmentId: EnvironmentId.make("environment"),
      provider: {
        instanceId: providerInstanceId,
        driverKind: "piAgent",
        enabled: true,
        runtimeVersion: "0.99.1",
        maxInputTokens: native ? 32000 : 100,
        maxOutputTokens: native ? 512 : 100,
        catalogue,
      },
      supportedToolIds: native
        ? ["pi.read", "pi.write", "project-work.report"]
        : ["pi.read", "pi.write"],
      ownedSkillIds: [],
      git: {
        primaryRoot: main,
        commonGitDirectory: main + "/.git",
        worktreePath: assigned,
        branchRef: "refs/heads/required-review",
        baseRef: "refs/heads/main",
        baseOid,
        policyHash: "b".repeat(64),
        writable: false,
      },
      rootAnchor: {
        _tag: "RetainedRoot",
        budget: {
          rootTaskId: f.snapshot.intent.limits.rootTaskId,
          maximumTokens: f.snapshot.intent.limits.maximumTokens,
          deadlineAtMs: f.snapshot.intent.limits.rootDeadlineAtMs,
        },
        caps: f.snapshot.intent.rootCaps,
      },
    },
  });
  if (prepared._tag !== "Prepared") return yield* Effect.die(prepared.reason);
  const request = prepared.request;
  const journal = yield* makeProjectTeamDispatchJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
  });
  const snapshot = yield* journal.claimEffect((yield* journal.reserve(request)).fence);
  const claim = snapshot.intent.compiledClaim.transition;
  if (claim?.kind !== "claim") return yield* Effect.die("Missing configured review claim");
  const binding = claim.binding;
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
    maxInputTokens: native ? 32000 : 100,
    maxOutputTokens: native ? 512 : 100,
    readCatalogue: Effect.succeed(catalogue),
    transport: async () => {
      transports++;
      throw Error("Required review transport forbidden");
    },
  };
  const repositoryPermit = yield* Semaphore.make(1);
  const workflowLayer = Layer.merge(
    Layer.mock(GitWorkflowService, {
      withRepositoryPermit: (_operation, _cwd, use) => repositoryPermit.withPermits(1)(use),
    }),
    Layer.mock(GitRepositoryPermits, {
      withRepositoryPermit: (_operation, _cwd, use) => repositoryPermit.withPermits(1)(use),
    }),
  );
  const runtime = yield* makePiManagedRuntimeLive(options).pipe(Effect.provide(workflowLayer));
  const instance = yield* runtime.forInstance({
    instanceId: providerInstanceId,
    enabled: true,
    configuration: {},
  });
  const reader = yield* makeProjectTeamContext({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 128,
  });
  yield* reader.readForOperation({
    projectId,
    bindingId: binding.recordId,
    generation: binding.generation,
    providerInstanceId,
    threadId: binding.threadId,
    operationId: request.initializeOperationId,
    operationKind: "initialize",
  });
  return {
    sql,
    repository,
    fs,
    options,
    instance,
    reader,
    request,
    snapshot,
    binding,
    implementationMain,
    implementationWorktree,
    implementationReceipt,
    workflowLayer,
    root: { snapshot: f.snapshot, bindingId: f.selection.bindingId, taskId: f.selection.taskId },
    get allocations() {
      return allocations;
    },
    get transports() {
      return transports;
    },
  };
});

type RuntimeFixtureProfile = {
  readonly role: "investigator" | "implementer";
  readonly instructions: string;
  readonly roleTools: ReadonlyArray<string>;
  readonly toolIds: ReadonlyArray<string>;
  readonly roleSkillIds: ReadonlyArray<string>;
  readonly skillIds: ReadonlyArray<string>;
  readonly maximumTokens: number;
  readonly durationMs: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly deliverableKind?: "non-code";
  readonly originalClockAtMs?: number;
  readonly ownedScratchDirectory?: string;
  readonly physicalWorkspace?: boolean;
  readonly model?: string;
  /** Two human-approved planning children; controlled parent receipts, real child SDK in the opt-in case. */
  readonly nativePlanningSiblings?: boolean;
  readonly memoryChild?: { readonly model: string; readonly maximumTokens: number };
};
const requiredTransferFixture = Effect.fn("requiredTransferFixture")(function* (
  reviewer = false,
  child = !reviewer,
  readonlyKind?: "planning" | "review" | "investigation",
  memory = false,
  memoryPolicy: "project" | "shared" | "none" | "read-only" = "project",
  assignment = "Implement the approved retained context",
  profile?: RuntimeFixtureProfile,
  revalidateRuntime?: PiManagedRuntimeLiveOptions["revalidateRuntime"],
) {
  const selectedModel = profile?.model ?? model;
  if (reviewer || readonlyKind === "review") return yield* requiredReviewTransferFixture();
  const fixtureAt =
    profile?.originalClockAtMs === undefined
      ? at
      : DateTime.formatIso(DateTime.makeUnsafe(profile.originalClockAtMs));
  if (profile?.originalClockAtMs === undefined) yield* TestClock.setTime(Date.parse(at) + 1);
  else expect(yield* Clock.currentTimeMillis).toBeGreaterThanOrEqual(profile.originalClockAtMs);
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  const fs = yield* FileSystem.FileSystem;
  const scratch = yield* fs.makeTempDirectoryScoped({ directory: profile?.ownedScratchDirectory });
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
  if (!profile?.physicalWorkspace)
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
      if (command.type === "project-work.foundation.commit") {
        const configured: typeof ProjectWorkFoundationCommitCommand.Type = {
          ...command,
          records: command.records.map((r) =>
            r.kind === "role-revision"
              ? {
                  ...r,
                  model: selectedModel,
                  ...(profile
                    ? {
                        instructions: profile.instructions,
                        tools: [...profile.roleTools],
                        skills: [...profile.roleSkillIds],
                      }
                    : {}),
                  ...(memory
                    ? {
                        memoryAccess: memoryPolicy === "read-only" ? "project" : memoryPolicy,
                        tools:
                          memoryPolicy === "read-only"
                            ? ["project-work.read-task"]
                            : ["project-work.write", "project-work.read-task"],
                      }
                    : {}),
                }
              : r.kind === "task-membership" && profile?.deliverableKind !== undefined
                ? { ...r, deliverableKind: profile.deliverableKind }
                : r,
          ),
        };
        if (profile?.deliverableKind !== undefined && command.commandId === "setup")
          return Effect.gen(function* () {
            const state = yield* readCurrentState(sql, command.projectId);
            if (state.tasks.length !== 1 || !state.tasks[0])
              return yield* Effect.die("Missing original report task");
            return yield* repository.execute(
              yield* decodeRequiredFoundation({
                ...configured,
                records: [
                  ...configured.records,
                  {
                    kind: "task-membership",
                    projectId: command.projectId,
                    taskId: state.tasks[0].taskId,
                    recordId: "runtime-profile-membership",
                    revision: 0,
                    generation: 0,
                    updatedAt: command.committedAt,
                    status: "active",
                    executionKind: "managed",
                    deliverableKind: profile.deliverableKind,
                    controlState: "active",
                  },
                ],
              }),
            );
          });
        return repository.execute(configured);
      }
      return repository.execute(command);
    },
  };
  const seedRepository = {
    ...captureClaim,
    execute: (command: ProjectWorkCommand) => {
      if (profile?.originalClockAtMs === undefined) return captureClaim.execute(command);
      // Original seed inputs only; stored authority and semantic content stay exact.
      const timestamps = new Set([
        "createdAt",
        "updatedAt",
        "recordedAt",
        "committedAt",
        "claimedAt",
      ]);
      return decodeNativeSmokeCommand(
        JSON.parse(
          JSON.stringify(command, (key, value) =>
            timestamps.has(key) && value === at ? fixtureAt : value,
          ),
        ),
      ).pipe(Effect.flatMap((original) => captureClaim.execute(original)));
    },
  };
  yield* seed(
    profile?.role ?? (reviewer && readonlyKind === undefined ? "reviewer" : "implementer"),
    "reserved",
    {
      nativeSessionId: null,
      roleTools: profile?.roleTools ?? [],
      toolIds: profile?.toolIds ?? [],
      issueCredential: false,
    },
  ).pipe(Effect.provideService(ProjectWorkRepository, seedRepository), Effect.result);
  if (!pending || pending.transition?.kind !== "claim")
    return yield* Effect.die("Missing original context claim");
  yield* repository.execute(
    yield* decodeRequiredFoundation({
      type: "project-work.foundation.commit",
      projectId,
      commandId: "required-limits",
      expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
      attribution,
      committedAt: fixtureAt,
      records: [
        {
          kind: "limits",
          projectId,
          recordId: "required-limits",
          revision: 0,
          generation: 0,
          updatedAt: fixtureAt,
          status: "configured",
          environmentModelCalls: 4,
          projectWritableWorkers: 2,
          modelCalls: 2,
          delegationDepth: 2,
          repairAllowance: 2,
          model: selectedModel,
          tokenLimit: profile?.maximumTokens ?? 2000,
          durationLimitMs: profile?.durationMs ?? 2000,
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
      model:
        id === "required-root" ? selectedModel : (profile?.memoryChild?.model ?? selectedModel),
      configuration: {
        ...claim.transition.binding.configuration,
        runtimeVersion: "0.99.1",
        ...(profile
          ? {
              toolIds: [...profile.toolIds],
              skillIds: [...profile.skillIds],
              maxTokens:
                id === "required-root"
                  ? profile.maximumTokens
                  : (profile.memoryChild?.maximumTokens ?? profile.maximumTokens),
              maxDurationMs:
                profile.nativePlanningSiblings && id !== "required-root"
                  ? 60_000
                  : profile.durationMs,
            }
          : {}),
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
      assignment:
        profile?.nativePlanningSiblings && id !== "required-root"
          ? `${assignment} (${id})`
          : assignment,
    };
    const reserveStartedAtMs = yield* Clock.currentTimeMillis;
    const reserved = yield* journal.reserve(request);
    const reserveFinishedAtMs = yield* Clock.currentTimeMillis;
    const snapshot = yield* journal.claimEffect(reserved.fence);
    if (profile?.originalClockAtMs !== undefined && id === "required-root") {
      expect(snapshot.intent.limits.rootDeadlineAtMs).toBeGreaterThanOrEqual(
        reserveStartedAtMs + profile.durationMs,
      );
      expect(snapshot.intent.limits.rootDeadlineAtMs).toBeLessThanOrEqual(
        reserveFinishedAtMs + profile.durationMs,
      );
      expect(snapshot.intent.limits.deadlineAtMs).toBeLessThanOrEqual(
        snapshot.intent.limits.rootDeadlineAtMs,
      );
    }
    yield* journal.readStageReceipts(snapshot.fence.dispatchId);
    return { request, snapshot, binding };
  });
  let retained = yield* reserve(pending, assigned, "refs/heads/required-root", "required-root");
  const root = retained;
  const siblings: Array<typeof retained> = [];
  if (profile?.nativePlanningSiblings && (!child || readonlyKind !== "planning"))
    return yield* Effect.die("Native siblings require genuine planning child authority");
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
    const parentNative = {
      sessionId: "required-parent-session",
      sessionReference: "sessions/parent.jsonl",
      leafId: null,
      persisted: false,
    };
    if (profile?.nativePlanningSiblings) {
      // Parent-only controlled history: no parent SDK/process is claimed. Use the real lifecycle
      // ports rather than changing stored authority, budgets or operation status with SQL.
      const owner = {
        type: "owner" as const,
        unit: parentAllocation.unit,
        nonce: parentAllocation.nonce,
        invocation: "a".repeat(32),
        cgroup: `/sys/fs/cgroup/controlled/${parentAllocation.unit}`,
        pid: 99999999,
        memoryBytes: parentAllocation.policy.memoryBytes,
        swapBytes: 0 as const,
        oomGroup: 1 as const,
      };
      const persistence = parentOperations.persistence(parent);
      yield* persistence.claimActivation(parentAllocation);
      yield* persistence.beforeStart(owner);
      yield* parentOperations.persistNative(parent, parentNative);
      yield* parentOperations.persistTerminal(parent, {
        identity: { workerId: parent.workerId, generation: parent.authority.binding.generation },
        operation: parent.operation,
        outcome: "success",
        ownerCaptured: true,
        native: parentNative,
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
      });
      const parentJournal = yield* makeProjectTeamDispatchJournal({
        environmentId: "environment",
        maximumEnvironmentModelCalls: 4,
        verifyStage: (receipt, original) =>
          receipt.evidence.bindingId === original.intent.request.git.runId
            ? Effect.void
            : Effect.fail(
                new ProjectTeamDispatchJournalError({ reason: "Foreign controlled parent" }),
              ),
      });
      let parentSnapshot = root.snapshot;
      for (const stage of [
        "workspace-ready",
        "setup-complete",
        "session-bound",
        "assignment-intent",
      ] as const)
        parentSnapshot = yield* parentJournal.readRetained(
          (yield* parentJournal.advanceStage(parentSnapshot.fence, {
            receiptId: `controlled-parent-${stage}`,
            stage,
            evidence: { bindingId: root.binding.recordId },
          })).fence.dispatchId,
        );
    } else {
      yield* parentOperations.persistNative(parent, parentNative);
      yield* sql`UPDATE project_team_pi_operation SET status='settled' WHERE operation_id=${parent.operation.operationId}`;
    }
    for (
      let siblingIndex = 0;
      siblingIndex < (profile?.nativePlanningSiblings ? 2 : 1);
      siblingIndex++
    ) {
      const suffix = siblingIndex === 0 ? "" : "-sibling";
      if (readonlyKind !== undefined) {
        let state = yield* readCurrentState(sql, projectId);
        const previousTaskIds = new Set(state.tasks.map((task) => task.taskId));
        const previousRoleIds = new Set(
          state.foundationRecords
            ?.filter((record) => record.kind === "role-revision")
            .map((record) => record.recordId),
        );
        const parentTask = state.tasks.find((task) => task.taskId === root.binding.taskId);
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
            record.kind === "gate" &&
            record.taskId === parentTask?.taskId &&
            record.gate === "plan",
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
          recordedAt: fixtureAt,
        } as const;
        const envelope = {
          projectId,
          taskId: parentTask.taskId,
          commandId: "readonly-runtime-grant" + suffix,
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
            committedAt: fixtureAt,
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
            !previousTaskIds.has(record.taskId) &&
            (record.gate === "assignment" || record.gate === "investigation"),
        );
        const task = state.tasks.find(
          (task) => task.taskId === (grant?.kind === "gate" ? grant.taskId : undefined),
        );
        const generatedRole = state.foundationRecords?.find(
          (record) => record.kind === "role-revision" && !previousRoleIds.has(record.recordId),
        );
        if (!task || grant?.kind !== "gate" || generatedRole?.kind !== "role-revision")
          return yield* Effect.die("Missing real readonly child scope");
        const roleRecord = {
          ...generatedRole,
          recordId: "readonly-runtime-role" + suffix,
          roleId: "readonly-runtime-role" + suffix,
          revision: 0,
          model: selectedModel,
          delegationDepth: role.delegationDepth,
        };
        yield* repository.execute(
          yield* decodeRequiredFoundation({
            type: "project-work.foundation.commit",
            projectId,
            commandId: "readonly-runtime-configure" + suffix,
            expectedRevision: state.revision,
            attribution: human,
            committedAt: fixtureAt,
            records: [
              roleRecord,
              {
                kind: "member",
                projectId,
                recordId: "readonly-runtime-member" + suffix,
                revision: 0,
                generation: 0,
                updatedAt: fixtureAt,
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
          recordId: "required-child-binding" + suffix,
          revision: 0,
          generation: 0,
          updatedAt: fixtureAt,
          status: "reserved",
          taskId: task.taskId,
          attemptId: "required-child-attempt" + suffix,
          memberId: "readonly-runtime-member" + suffix,
          roleRevisionId: roleRecord.recordId,
          parentRunId: root.binding.recordId,
          providerInstanceId,
          threadId: siblingIndex === 0 ? threadId : ThreadId.make("required-sibling-thread"),
          environmentId: "environment",
          model: selectedModel,
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
          commandId: "readonly-runtime-claim" + suffix,
          expectedRevision: state.revision,
          attribution,
          committedAt: fixtureAt,
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
              commandId: "readonly-runtime-claim" + suffix,
              attemptId: binding.attemptId,
              leaseToken: "readonly-runtime-lease" + suffix,
              leasedUntil: "2030-01-01T00:00:00.000Z",
              claimedAt: fixtureAt,
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
          createdAt: fixtureAt,
        });
        yield* repository.execute(
          yield* decodeRequiredFoundation({
            type: "project-work.foundation.commit",
            projectId,
            commandId: "required-child-membership",
            expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
            attribution,
            committedAt: fixtureAt,
            records: [
              {
                kind: "task-membership",
                projectId,
                recordId: "required-child-membership",
                revision: 0,
                generation: 0,
                updatedAt: fixtureAt,
                status: "active",
                taskId: "required-child",
                parentTaskId: root.binding.taskId,
                executionKind: "managed",
                deliverableKind: "code",
                controlState: "active",
              },
            ],
          }),
        );
        let childRole = role;
        if (profile?.memoryChild) {
          childRole = {
            ...role,
            recordId: "required-memory-child-role",
            roleId: "memory-child-role",
            model: profile.memoryChild.model,
          };
          const state = yield* readCurrentState(sql, projectId);
          const member = state.foundationRecords?.find(
            (r) => r.kind === "member" && r.recordId === "member",
          );
          if (member?.kind !== "member") return yield* Effect.die("Original member absent");
          const policy = state.foundationRecords?.find(
            (r) => r.kind === "limits" && r.model === selectedModel,
          );
          if (policy?.kind !== "limits")
            return yield* Effect.die("Original root model policy absent");
          yield* repository.execute(
            yield* decodeRequiredFoundation({
              type: "project-work.foundation.commit",
              projectId,
              commandId: "required-memory-child-role",
              expectedRevision: state.revision,
              attribution,
              committedAt: fixtureAt,
              records: [
                childRole,
                {
                  ...member,
                  recordId: "required-memory-child-member",
                  roleRevisionId: childRole.recordId,
                },
                ...(childRole.model === selectedModel
                  ? []
                  : [
                      {
                        ...policy,
                        recordId: "required-memory-child-limits",
                        model: childRole.model,
                      },
                    ]),
              ],
            }),
          );
        }
        pending = undefined;
        yield* createManagedAssignment({
          taskId: ProjectWorkTaskId.make("required-child"),
          recordId: "required-child-binding" + suffix,
          attemptId: "required-child-attempt" + suffix,
          commandId: "required-child-claim",
          providerInstanceId,
          threadId,
          role: childRole,
          ...(profile?.memoryChild ? { memberId: "required-memory-child-member" } : {}),
          status: "reserved",
          configuration,
          parentRunId: root.binding.recordId,
        }).pipe(Effect.provideService(ProjectWorkRepository, captureClaim), Effect.result);
        if (!pending) return yield* Effect.die("Missing child claim");
      }
      const childId = "required-child" + suffix;
      const childPath = scratch + "/child" + suffix;
      yield* git(["-C", main, "worktree", "add", "-qb", childId, childPath]);
      retained = yield* reserve(pending, childPath, "refs/heads/" + childId, childId);
      siblings.push(retained);
    }
    retained = siblings[0]!;
  }
  let allocations = 0;
  let transports = 0;
  const options: PiManagedRuntimeLiveOptions = {
    environmentId: "environment",
    ...(revalidateRuntime ? { revalidateRuntime } : {}),
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
    maxInputTokens: profile?.maxInputTokens ?? 100,
    maxOutputTokens: profile?.maxOutputTokens ?? 100,
    readCatalogue: Effect.succeed({
      source: "https://api.commandcode.ai/provider/v1/models",
      fetchedAt: fixtureAt,
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
    root,
    siblings,
    get allocations() {
      return allocations;
    },
    get transports() {
      return transports;
    },
  };
});

const basicRuntimeProfile: RuntimeFixtureProfile = {
  role: "investigator",
  instructions: "Investigate current assignment",
  roleTools: [],
  toolIds: [],
  roleSkillIds: [],
  skillIds: [],
  maximumTokens: 20000,
  durationMs: 300000,
  maxInputTokens: 10000,
  maxOutputTokens: 512,
};
const dispatchedRuntimeFixture = Effect.fn("dispatchedRuntimeFixture")(function* (
  profile: RuntimeFixtureProfile = basicRuntimeProfile,
) {
  const f = yield* requiredTransferFixture(
    false,
    false,
    undefined,
    false,
    "project",
    "Investigate current assignment",
    profile,
  );
  const journal = yield* makeProjectTeamDispatchJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
    // Existing disposable Git and controlled setup receipts; no setup or initializer runs.
    verifyStage: (receipt, original) =>
      receipt.evidence.bindingId === original.intent.request.git.runId &&
      receipt.evidence.setupId === original.intent.request.setupId
        ? Effect.void
        : Effect.fail(
            new ProjectTeamDispatchJournalError({ reason: "Foreign controlled runtime setup" }),
          ),
  });
  let snapshot = f.snapshot;
  for (const stage of profile.physicalWorkspace
    ? []
    : (["workspace-ready", "setup-complete"] as const))
    snapshot = yield* journal.readRetained(
      (yield* journal.advanceStage(snapshot.fence, {
        receiptId: `runtime-fixture-${stage}`,
        stage,
        evidence: { bindingId: f.binding.recordId, setupId: f.request.setupId },
      })).fence.dispatchId,
    );
  const runtime = yield* makePiManagedRuntimeLive(f.options);
  return {
    ...f,
    snapshot,
    runtime,
    main: f.request.git.primaryRoot,
    worktree: f.binding.worktree,
    get allocations() {
      return f.allocations;
    },
    get transports() {
      return f.transports;
    },
  };
});

const initializeRequiredContext = Effect.fn("initializeRequiredContext")(function* (
  f: Effect.Success<ReturnType<typeof requiredTransferFixture>>,
  retainAssignment = false,
  targetInstance: PiManagedRuntimeInstance = f.instance,
) {
  const journal = yield* makeProjectTeamDispatchJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 4,
    // These receipts sequence controlled SQL/Git setup, without a native setup process.
    verifyStage: (receipt, original) =>
      receipt.evidence.bindingId === original.intent.request.git.runId
        ? Effect.void
        : Effect.fail(new ProjectTeamDispatchJournalError({ reason: "Foreign controlled stage" })),
  });
  let snapshot = f.snapshot;
  const stage = Effect.fn("initializeRequiredContext.stage")(function* (
    value: "workspace-ready" | "setup-complete" | "session-bound" | "assignment-intent",
  ) {
    snapshot = yield* journal.readRetained(
      (yield* journal.advanceStage(snapshot.fence, {
        receiptId: `required-context-${value}`,
        stage: value,
        evidence: { bindingId: f.binding.recordId },
      })).fence.dispatchId,
    );
  });
  yield* stage("workspace-ready");
  yield* stage("setup-complete");
  const services = yield* Effect.context<
    SqlClient.SqlClient | ProjectWorkRepository | Authorization.ProjectTeamAuthorization
  >();
  const original = SessionRuntime.makePiSessionRuntime;
  const spy = vi.spyOn(SessionRuntime, "makePiSessionRuntime").mockImplementation((input) =>
    original(input).pipe(
      Effect.map((session) => ({
        ...session,
        run: () =>
          Effect.gen(function* () {
            // The real parent callbacks retain controlled ownership; no native process runs.
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
            const native = {
              sessionId: "required-session",
              sessionReference: "sessions/required.jsonl",
              leafId:
                input.operation.operationKind === "prompt"
                  ? "required-assignment"
                  : "required-initialize",
              persisted: true,
            };
            const briefing = input.transferTexts.find(
              (entry) =>
                entry.transferId ===
                (input.operation.operationKind === "prompt" ? "prompt" : "context"),
            )?.text;
            if (briefing === undefined)
              return yield* Effect.die("Missing original controlled transfer");
            yield* f.fs.makeDirectory(allocation.launch.nativeStateRoot + "/sessions", {
              recursive: true,
            });
            const nativeFile = allocation.launch.nativeStateRoot + "/" + native.sessionReference;
            const records = [
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
                parentId: input.operation.operationKind === "prompt" ? "required-initialize" : null,
                timestamp: at,
                message: {
                  role: "user",
                  content: [{ type: "text", text: briefing }],
                  timestamp: Date.parse(at),
                },
              },
            ];
            const prior =
              input.operation.operationKind === "prompt"
                ? yield* f.fs.readFileString(nativeFile)
                : "";
            yield* f.fs.writeFileString(
              nativeFile,
              prior +
                records
                  .filter(
                    (entry) =>
                      input.operation.operationKind === "initialize" || entry.type !== "session",
                  )
                  .map((entry) => json(entry))
                  .join("\n") +
                "\n",
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
                    input.operation.operationKind === "prompt"
                      ? { type: "native", lifecycleId: 1, native }
                      : { type: "initialized", native },
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
                  code: "CONTROLLED_REQUIRED_INITIALIZE",
                }),
            ),
            Effect.provide(services),
          ),
      })),
    ),
  );
  yield* Effect.gen(function* () {
    const initialized = yield* targetInstance.prepareOperation(
      {
        threadId: f.binding.threadId,
        kind: "initialize",
        operationId: f.request.initializeOperationId,
      },
      () => Effect.void,
    );
    expect((yield* initialized.run).terminal.outcome).toBe("success");
    yield* stage("session-bound");
    yield* stage("assignment-intent");
    if (retainAssignment) {
      const assigned = yield* targetInstance.prepareOperation(
        {
          threadId: f.binding.threadId,
          kind: "prompt",
          operationId: f.request.assignmentOperationId,
          prompt: f.request.assignment,
        },
        () => Effect.void,
      );
      expect((yield* assigned.run).terminal.outcome).toBe("success");
    }
  }).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
  return snapshot;
});

const decodeActivationFrame = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literals(["owner", "started", "stdout", "stderr", "exited", "failed"]),
      pid: Schema.optional(Schema.Int),
    }),
  ),
);
describe.runIf(process.env.PI_MANAGED_RUNTIME_ACTIVATION_SMOKE === "1")(
  "genuine approved native SDK activation",
  () => {
    it.live(
      "runs original initialization, assignment and approved verification under the retained task cap",
      () =>
        scoped(
          Effect.gen(function* () {
            const distributionDirectory = process.env.PI_MANAGED_RUNTIME_INITIALIZATION_DIST;
            const evidence = process.env.PI_MANAGED_RUNTIME_TEST_EVIDENCE;
            if (!distributionDirectory || !evidence)
              return yield* Effect.die(
                "Owned current distribution and native evidence are required",
              );
            const fs = yield* FileSystem.FileSystem;
            yield* fs.makeDirectory(evidence, { recursive: true });
            const ownedScratchDirectory = distributionDirectory + "-owned-runtime";
            yield* fs.makeDirectory(ownedScratchDirectory, { recursive: true, mode: 0o700 });
            const stage = yield* fs.makeTempDirectoryScoped({
              directory: ownedScratchDirectory,
              prefix: "assets-",
            });
            yield* fs.chmod(stage, 0o700);
            yield* Effect.addFinalizer(() => fs.chmod(stage, 0o700).pipe(Effect.orDie));
            const assets = yield* preparePiRuntimeAssets({
              distributionDirectory,
              stagingDirectory: stage,
              protectedRoots: [evidence],
            });
            const closure = yield* Effect.forEach(assets.runtimeFiles, (file) =>
              fs.readFile(file.source).pipe(
                Effect.map((bytes) => ({
                  ...file,
                  bytes: bytes.length,
                  sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
                })),
              ),
            );
            yield* fs.writeFileString(evidence + "/closure.json", json(closure));
            const settings = yield* ServerSettings.ServerSettingsService;
            yield* settings.updateSettings({ projectTeamExecutionEnabled: true });
            const approvedAtMs = yield* Clock.currentTimeMillis;
            const subscriptionSmoke = process.env.PI_MANAGED_RUNTIME_SUBSCRIPTION_SMOKE === "1";
            const subscriptionToolsSmoke =
              subscriptionSmoke && process.env.PI_MANAGED_RUNTIME_SUBSCRIPTION_TOOLS_SMOKE === "1";
            const subscriptionFailureSmoke =
              subscriptionSmoke &&
              process.env.PI_MANAGED_RUNTIME_SUBSCRIPTION_FAILURE_SMOKE === "1";
            const durationMs = subscriptionSmoke ? 300_000 : 60_000;
            const maxInputTokens = subscriptionSmoke ? 16_384 : 12_000;
            const f = yield* dispatchedRuntimeFixture({
              ...(subscriptionSmoke ? subscriptionRuntimeProfile : basicRuntimeProfile),
              ...(subscriptionToolsSmoke
                ? {
                    roleTools: ["project-work.report", "pi.read", "pi.write"],
                    toolIds: ["project-work.report", "pi.read", "pi.write"],
                  }
                : {}),
              role: "implementer",
              durationMs,
              maxInputTokens,
              originalClockAtMs: approvedAtMs,
              ownedScratchDirectory,
              physicalWorkspace: true,
            });
            expect(f.request.claim.committedAt).toBe(
              DateTime.formatIso(DateTime.makeUnsafe(approvedAtMs)),
            );
            const originalDeadlineAtMs = f.snapshot.intent.limits.rootDeadlineAtMs;
            expect(originalDeadlineAtMs).toBeGreaterThanOrEqual(approvedAtMs + durationMs);
            expect(yield* Clock.currentTimeMillis).toBeLessThan(
              f.snapshot.intent.limits.deadlineAtMs,
            );
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                const budgets =
                  yield* f.sql`SELECT environment_id,project_id,task_id,deadline_at_ms,memory_bytes FROM project_task_resource_budget LIMIT 2`;
                const children =
                  yield* f.sql`SELECT unit,nonce,authority_id,memory_bytes,deadline_at_ms,allocation_json,owner_json,drain_json FROM project_task_resource_child LIMIT 3`;
                const operations =
                  yield* f.sql`SELECT operation_id,status,terminal_json FROM project_team_pi_operation ORDER BY operation_ordinal LIMIT 3`;
                yield* fs.writeFileString(
                  evidence + "/retained-sql.json",
                  json({ budgets, children, operations }),
                );
                const sessions: Array<{ path: string; content: string }> = [];
                for (const namespace of yield* fs.readDirectory(f.options.nativeStateRoot)) {
                  const directory = f.options.nativeStateRoot + "/" + namespace + "/sessions";
                  if (!(yield* fs.exists(directory))) continue;
                  for (const name of yield* fs.readDirectory(directory)) {
                    if (!name.endsWith(".jsonl")) continue;
                    if (sessions.length >= 2)
                      return yield* Effect.die("Native session evidence count exceeded");
                    const path = directory + "/" + name;
                    const stat = yield* fs.stat(path);
                    if (Number(stat.size) > 1048576)
                      return yield* Effect.die("Native session evidence bytes exceeded");
                    sessions.push({ path, content: yield* fs.readFileString(path) });
                  }
                }
                yield* fs.writeFileString(evidence + "/sessions.json", json(sessions));
              }).pipe(Effect.orDie),
            );
            const syntheticAccess = `header.${Buffer.from(
              json({
                exp: Math.ceil(originalDeadlineAtMs / 1000) + 60,
                "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-native-account" },
              }),
            ).toString("base64url")}.signature`;
            yield* fs.writeFileString(
              f.options.agentDirectory + "/auth.json",
              json(
                subscriptionSmoke
                  ? {
                      "openai-codex": {
                        type: "oauth",
                        access: syntheticAccess,
                        expires: originalDeadlineAtMs + 60_000,
                        accountId: "synthetic-native-account",
                      },
                    }
                  : { "command-code": { type: "api_key", key: "synthetic-parent-key" } },
              ),
            );
            const captured: Array<{
              unit: string;
              kind: string;
              pid: number;
              startTime: string;
            }> = [];
            const capture = Effect.fn("nativeSmoke.capture")(function* (
              unit: string,
              kind: string,
              pid: number,
            ) {
              const stat = yield* fs.readFileString(`/proc/${pid}/stat`);
              const startTime = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
              if (!startTime || !/^\d+$/.test(startTime))
                return yield* Effect.die("Captured native PID has no original start identity");
              captured.push({ unit, kind, pid, startTime });
              yield* fs.writeFileString(evidence + "/captured-pids.json", json(captured));
            });
            const assertChildrenDrained = Effect.fn("nativeSmoke.assertChildrenDrained")(function* (
              children: readonly { unit: string; owner_json: string; drain_json: string }[],
            ) {
              for (const child of children) {
                const owner = parseOwner(child.owner_json);
                const drain = parseFullDrain(child.drain_json);
                expect(owner.unit).toBe(child.unit);
                expect(drain.unit).toBe(child.unit);
                expect(drain.invocation).toBe(owner.invocation);
                expect(drain.memoryBytes).toBe(536870912);
                expect(drain.swapBytes).toBe(0);
                expect(drain.oomGroup).toBe(1);
                expect(drain.kernel === "removed" || drain.kernel.includes("populated 0")).toBe(
                  true,
                );
                const identities = captured.filter((item) => item.unit === child.unit);
                expect(identities.map((item) => item.kind)).toEqual([
                  "launcher",
                  "owner",
                  "started",
                ]);
                expect(identities.map((item) => item.pid)).toEqual([
                  drain.launcherPid,
                  drain.ownerPid,
                  drain.childPid,
                ]);
                for (const item of identities) {
                  const stat = yield* fs
                    .readFileString(`/proc/${item.pid}/stat`)
                    .pipe(Effect.option);
                  if (Option.isSome(stat))
                    expect(
                      stat.value.slice(stat.value.lastIndexOf(") ") + 2).split(" ")[19],
                    ).not.toBe(item.startTime);
                }
                if (yield* fs.exists(drain.cgroup + "/cgroup.events"))
                  expect(yield* fs.readFileString(drain.cgroup + "/cgroup.events")).toContain(
                    "populated 0",
                  );
              }
            });
            const originalSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            let nativeLauncherExited = Promise.withResolvers<void>();
            const observed = ChildProcessSpawner.make((command) => {
              if (command._tag !== "StandardCommand" || command.command !== "/usr/bin/systemd-run")
                return originalSpawner.spawn(command);
              const unit = command.args.find((arg) => arg.startsWith("--unit="))?.slice(7);
              if (!unit) return originalSpawner.spawn(command);
              const launcherExited = Promise.withResolvers<void>();
              nativeLauncherExited = launcherExited;
              let pending = Buffer.alloc(0);
              let transcript = Buffer.alloc(0);
              const args = [...command.args];
              const helperIndex = args.indexOf("/usr/bin/python3");
              if (helperIndex < 0) return Effect.die("Native owner helper command absent");
              args.splice(
                helperIndex,
                0,
                "-p",
                "TasksMax=128",
                "-p",
                "CPUQuota=200%",
                "-p",
                "AllowedCPUs=0,1",
              );
              return originalSpawner
                .spawn(ChildProcess.make(command.command, args, command.options))
                .pipe(
                  Effect.tap((handle) => capture(unit, "launcher", Number(handle.pid))),
                  Effect.tap((handle) =>
                    fs.writeFileString(
                      evidence + "/" + unit + ".launch.json",
                      json({
                        command: command.command,
                        args,
                        launcherPid: Number(handle.pid),
                        qualification:
                          "Stricter native test envelope; original memory/deadline/allocation unchanged",
                      }),
                    ),
                  ),
                  Effect.map((handle) =>
                    ChildProcessSpawner.makeHandle({
                      ...handle,
                      exitCode: handle.exitCode.pipe(
                        Effect.tap(() => Effect.sync(() => launcherExited.resolve())),
                      ),
                      stdout: handle.stdout.pipe(
                        Stream.tap((chunk) =>
                          Effect.gen(function* () {
                            transcript = Buffer.concat([transcript, chunk]);
                            if (transcript.byteLength > 1048576)
                              return yield* Effect.die(
                                "Native diagnostic transcript exceeded its bound",
                              );
                            yield* fs.writeFile(
                              evidence + "/" + unit + ".frames.jsonl",
                              transcript,
                            );
                            pending = Buffer.concat([pending, chunk]);
                            for (;;) {
                              const newline = pending.indexOf(10);
                              if (newline < 0) break;
                              if (newline > 65536)
                                return yield* Effect.die(
                                  "Native ownership frame exceeded its bound",
                                );
                              const frame = yield* decodeActivationFrame(
                                pending.subarray(0, newline).toString("utf8"),
                              ).pipe(Effect.orDie);
                              pending = pending.subarray(newline + 1);
                              if (frame.type === "owner" || frame.type === "started") {
                                if (frame.pid === undefined)
                                  return yield* Effect.die("Native ownership frame omitted PID");
                                yield* capture(unit, frame.type, frame.pid);
                              }
                            }
                            if (pending.byteLength > 65536)
                              return yield* Effect.die("Native ownership frame exceeded its bound");
                          }),
                        ),
                      ),
                    }),
                  ),
                );
            });
            let calls = 0;
            const originalSessionRuntime = SessionRuntime.makePiSessionRuntime;
            const raceSpy = vi
              .spyOn(SessionRuntime, "makePiSessionRuntime")
              .mockImplementation((input) =>
                originalSessionRuntime({
                  ...input,
                  ...(subscriptionToolsSmoke
                    ? {
                        broker: {
                          ...input.broker,
                          requiredSystemText: input.transferTexts.find(
                            (transfer) => transfer.transferId === "context",
                          )!.text,
                          // This fixture checks the SDK text boundary; mailbox SQL is separate.
                          bindRequestInput: async () => {},
                        },
                      }
                    : {}),
                  onWorkerFrame: async (frame, signal) => {
                    // Force native exit to overtake buffered receipt processing.
                    if (subscriptionSmoke && frame.message.type === "native")
                      await nativeLauncherExited.promise;
                    await input.onWorkerFrame?.(frame, signal);
                  },
                }).pipe(
                  Effect.tapCause((cause) =>
                    fs
                      .writeFileString(
                        evidence + "/session-configuration-failure.txt",
                        Cause.pretty(cause),
                      )
                      .pipe(Effect.orDie),
                  ),
                ),
              );
            yield* Effect.addFinalizer(() => Effect.sync(() => raceSpy.mockRestore()));
            const runtime = yield* makePiManagedRuntimeLive({
              ...f.options,
              ...assets,
              memoryBytes: 536870912,
              maxInputTokens,
              maxOutputTokens: subscriptionSmoke ? 2_048 : 512,
              ...(subscriptionSmoke
                ? {
                    subscriptionTest: {
                      selection: subscriptionSelection(f),
                      credentialSource: {
                        directory: f.options.agentDirectory,
                        format: "pi" as const,
                      },
                    },
                  }
                : {}),
              cleanupDeadlineMs: 5000,
              revalidateRuntime: assets.revalidate.pipe(
                Effect.mapError(
                  (cause) =>
                    new PiManagedRuntimeError({ code: "unavailable", detail: cause.message }),
                ),
              ),
              workerArgv: (identity, operation) =>
                assets.workerArgv(identity, operation, "/state/sessions"),
              readCatalogue: Effect.succeed({
                source: "https://api.commandcode.ai/provider/v1/models",
                fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(approvedAtMs)),
                selectedEntry: {
                  id: model,
                  owned_by: "command-code",
                  context_length: 20000,
                  supported_endpoints: ["/chat/completions"],
                },
              }),
              transport: async (_url, init) => {
                calls++;
                await process
                  .getBuiltinModule("fs")
                  .promises.writeFile(
                    evidence + "/model-request.json",
                    json({ calls, headers: init.headers, body: init.body }),
                    "utf8",
                  );
                expect(calls).toBe(1);
                expect(Buffer.byteLength(init.body)).toBeLessThanOrEqual(maxInputTokens);
                if (subscriptionSmoke) {
                  expect(init.headers).toMatchObject({
                    Authorization: `Bearer ${syntheticAccess}`,
                    "chatgpt-account-id": "synthetic-native-account",
                    "OpenAI-Beta": "responses=experimental",
                    accept: "text/event-stream",
                  });
                  const body = JSON.parse(init.body);
                  expect(body).toMatchObject({
                    model: "gpt-6-luna",
                    stream: true,
                    store: false,
                    reasoning: { effort: "high" },
                    service_tier: "default",
                  });
                  expect(body.instructions).toContain(f.request.assignment);
                  expect(body).not.toHaveProperty("messages");
                  if (subscriptionFailureSmoke)
                    return new Response("controlled unknown usage", { status: 503 });
                  const message = {
                    type: "message",
                    id: "native-message",
                    role: "assistant",
                    status: "completed",
                    content: [
                      { type: "output_text", text: "Native smoke complete", annotations: [] },
                    ],
                  };
                  const events = [
                    {
                      type: "response.created",
                      response: {
                        id: "native-response",
                        model: "gpt-6-luna",
                        status: "in_progress",
                      },
                    },
                    {
                      type: "response.output_item.added",
                      output_index: 0,
                      item: { ...message, status: "in_progress", content: [] },
                    },
                    {
                      type: "response.content_part.added",
                      output_index: 0,
                      content_index: 0,
                      item_id: message.id,
                      part: { type: "output_text", text: "", annotations: [] },
                    },
                    {
                      type: "response.output_text.delta",
                      output_index: 0,
                      content_index: 0,
                      item_id: message.id,
                      delta: "Native smoke complete",
                    },
                    { type: "response.output_item.done", output_index: 0, item: message },
                    {
                      type: "response.completed",
                      response: {
                        id: "native-response",
                        model: "gpt-6-luna",
                        status: "completed",
                        output: [message],
                        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
                      },
                    },
                  ];
                  return new Response(
                    events
                      .map((event) => `event: ${event.type}\ndata: ${json(event)}\n\n`)
                      .join(""),
                    { headers: { "content-type": "text/event-stream" } },
                  );
                }
                expect(init.headers).toEqual({
                  "Content-Type": "application/json",
                  Authorization: "Bearer synthetic-parent-key",
                });
                const data = [
                  {
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: { role: "assistant", content: "Native smoke complete" },
                        finish_reason: null,
                      },
                    ],
                  },
                  { model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
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
            }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed));
            const instance = yield* runtime.forInstance({
              instanceId: providerInstanceId,
              enabled: true,
              configuration: {},
            });
            const pi = yield* makeProjectTeamPiRuntime();
            const revalidateAssets = assets.revalidate.pipe(
              Effect.mapError(
                (cause) =>
                  new PiManagedRuntimeError({ code: "unavailable", detail: cause.message }),
              ),
            );
            const ownedAssets = {
              runtimeFiles: assets.runtimeFiles,
              revalidate: revalidateAssets,
              borrow: <A, E, R>(use: Effect.Effect<A, E, R>) =>
                revalidateAssets.pipe(Effect.andThen(use)),
            };
            yield* pi.publishAssets(providerInstanceId, ownedAssets, instance);
            const permit = yield* Semaphore.make(1);
            const withRepositoryPermit = <A, E, R>(
              _operation: string,
              cwd: string,
              use: Effect.Effect<A, E, R>,
            ) =>
              ManagedGit.canonicalGitMutationKey(f.request.git.commonGitDirectory, cwd).pipe(
                Effect.flatMap((key) => {
                  expect(key).toBe(`git\0${f.request.git.commonGitDirectory}`);
                  return permit.withPermits(1)(use);
                }),
              );
            const physicalServices = Layer.mergeAll(
              Layer.succeed(ProjectTeamPiRuntime, pi),
              Layer.mock(GitRepositoryPermits, { withRepositoryPermit }),
              Layer.mock(GitWorkflowService, {
                withRepositoryPermit,
                createWorktree: (input, options) => {
                  if (!options?.managed)
                    return Effect.die("Native fixture requires original managed Git context");
                  return permit.withPermits(1)(
                    ManagedGit.createManagedWorktree(options.managed, input),
                  );
                },
              }),
              Layer.mock(ProjectionSnapshotQuery, {
                getProjectShellById: (selected) =>
                  selected === projectId
                    ? Effect.succeed(
                        Option.some(
                          decodeNativeSmokeShell({
                            id: projectId,
                            title: "Native smoke",
                            workspaceRoot: f.main,
                            defaultModelSelection: null,
                            scripts: [],
                            createdAt: DateTime.formatIso(DateTime.makeUnsafe(approvedAtMs)),
                            updatedAt: DateTime.formatIso(DateTime.makeUnsafe(approvedAtMs)),
                          }),
                        ),
                      )
                    : Effect.succeed(Option.none()),
              }),
            );
            const originalDispatch = yield* makeProjectTeamDispatchJournal({
              environmentId: "environment",
              maximumEnvironmentModelCalls: 4,
            });
            const workspace = yield* makeProjectTeamWorkspace({
              environmentId: "environment",
              maximumEnvironmentModelCalls: 4,
              launchPolicy: { memoryBytes: 536870912, runtimeSeconds: 30 },
              protectedRoots: [evidence],
              assertCurrent: (original) =>
                originalDispatch.inspect(original.fence.dispatchId).pipe(
                  Effect.flatMap((current) =>
                    canonicalProjectWorkPayload(current) === canonicalProjectWorkPayload(original)
                      ? Effect.void
                      : Effect.fail(
                          new ProjectTeamDispatchJournalError({
                            reason: "Native dispatch changed",
                          }),
                        ),
                  ),
                  Effect.mapError(
                    () =>
                      new ProjectTeamDispatchJournalError({
                        reason: "Native original dispatch audit failed",
                      }),
                  ),
                ),
            }).pipe(Effect.provide(physicalServices));
            let snapshot = f.snapshot;
            const { workspace: physical } = yield* workspace.workspace(snapshot);
            const stages = yield* makeProjectTeamDispatchJournal({
              environmentId: "environment",
              maximumEnvironmentModelCalls: 4,
              verifyStage: (receipt, original) =>
                receipt.stage === "workspace-ready"
                  ? workspace.verifyRetained(original, physical).pipe(
                      Effect.scoped,
                      Effect.mapError(
                        () =>
                          new ProjectTeamDispatchJournalError({
                            reason: "Native physical workspace changed",
                          }),
                      ),
                    )
                  : workspace.verifyRetained(original, physical, setup).pipe(
                      Effect.scoped,
                      Effect.mapError(
                        () =>
                          new ProjectTeamDispatchJournalError({
                            reason: "Native setup completion changed",
                          }),
                      ),
                    ),
            });
            snapshot = yield* stages.readRetained(
              (yield* stages.advanceStage(snapshot.fence, {
                receiptId: "native-physical-workspace-ready",
                stage: "workspace-ready",
                evidence: { workspace: physical },
              })).fence.dispatchId,
            );
            const setup = yield* workspace.setup(snapshot, physical);
            expect(setup.outcome).toBe("skipped");
            snapshot = yield* stages.readRetained(
              (yield* stages.advanceStage(snapshot.fence, {
                receiptId: "native-physical-setup-complete",
                stage: "setup-complete",
                evidence: { workspace: physical, setup: decodeNativeJsonEvidence(json(setup)) },
              })).fence.dispatchId,
            );
            yield* fs.writeFileString(
              evidence + "/workspace-setup.json",
              json({
                physical,
                setup,
                snapshot,
                qualification:
                  "Actual ManagedGit and no-script SetupRuntime; test-local project shell and canonical repository permit",
              }),
            );
            const initialized = yield* instance.prepareOperation(
              {
                threadId: f.binding.threadId,
                kind: "initialize",
                operationId: f.request.initializeOperationId,
              },
              () => Effect.void,
            );
            const first = yield* initialized.run;
            expect(first.terminal.outcome).toBe("success");
            expect(calls).toBe(0);
            const budget =
              yield* f.sql`SELECT deadline_at_ms,memory_bytes FROM project_task_resource_budget LIMIT 2`;
            expect(budget).toEqual([
              { deadline_at_ms: f.snapshot.intent.limits.deadlineAtMs, memory_bytes: 2147483648 },
            ]);
            const sessionReceipts = yield* makeProjectTeamSessionReceipts({
              environmentId: "environment",
              maximumEnvironmentModelCalls: 4,
            });
            const journal = yield* makeProjectTeamDispatchJournal({
              environmentId: "environment",
              maximumEnvironmentModelCalls: 4,
              verifyStage: (receipt, original) =>
                Effect.gen(function* () {
                  expect(receipt.evidence.bindingId).toBe(original.intent.request.git.runId);
                  expect(receipt.evidence.initializeOperationId).toBe(
                    original.intent.request.initializeOperationId,
                  );
                  const retained = yield* sessionReceipts.readInitialization(original);
                  if (!retained)
                    return yield* new ProjectTeamDispatchJournalError({
                      reason: "Native initialization receipt absent",
                    });
                  expect(retained).toBeDefined();
                }).pipe(
                  Effect.mapError(
                    () =>
                      new ProjectTeamDispatchJournalError({
                        reason: "Native initialization receipt audit failed",
                      }),
                  ),
                ),
            });
            for (const stage of ["session-bound", "assignment-intent"] as const)
              snapshot = yield* journal.readRetained(
                (yield* journal.advanceStage(snapshot.fence, {
                  receiptId: `native-smoke-${stage}`,
                  stage,
                  evidence: {
                    bindingId: f.binding.recordId,
                    initializeOperationId: f.request.initializeOperationId,
                  },
                })).fence.dispatchId,
              );
            const assignment = yield* instance.prepareOperation(
              {
                threadId: f.binding.threadId,
                kind: "prompt",
                operationId: f.request.assignmentOperationId,
                prompt: f.request.assignment,
              },
              () => Effect.void,
            );
            if (subscriptionFailureSmoke) {
              const refused = yield* assignment.run.pipe(Effect.result);
              expect(refused).toMatchObject({ _tag: "Failure", failure: { code: "uncertain" } });
              expect(calls).toBe(1);
              expect(
                yield* f.sql`SELECT status,capacity_state,charged_input_tokens,charged_output_tokens
                FROM project_team_model_request WHERE operation_id=${assignment.operation.operationId}`,
              ).toEqual([
                {
                  status: "unknown",
                  capacity_state: "quarantine",
                  charged_input_tokens: 16_384,
                  charged_output_tokens: 64_000,
                },
              ]);
              expect(
                yield* f.sql`SELECT stop_reason FROM project_team_pi_subscription_grant`,
              ).toEqual([{ stop_reason: "unknown-usage" }]);
              const children = yield* f.sql<{
                unit: string;
                owner_json: string;
                drain_json: string;
              }>`SELECT unit,owner_json,drain_json
                FROM project_task_resource_child LIMIT 3`;
              expect(children).toHaveLength(2);
              expect(
                yield* f.sql`SELECT unit FROM project_task_resource_child WHERE drain_json IS NULL`,
              ).toEqual([]);
              yield* assertChildrenDrained(children);
              yield* fs.writeFileString(
                evidence + "/native-failure-results.json",
                json({
                  originalDeadlineAtMs,
                  originalBudget: budget,
                  refused,
                  children,
                  calls,
                  captured,
                }),
              );
              return;
            }
            const second = yield* assignment.run;
            expect(second.terminal.outcome).toBe("success");
            expect(calls).toBe(1);
            const children = yield* f.sql<{
              unit: string;
              owner_json: string;
              drain_json: string;
            }>`SELECT unit,owner_json,drain_json FROM project_task_resource_child LIMIT 3`;
            expect(children).toHaveLength(2);
            expect(
              yield* f.sql`SELECT deadline_at_ms,memory_bytes FROM project_task_resource_budget LIMIT 2`,
            ).toEqual(budget);
            expect(
              yield* f.sql`SELECT unit FROM project_task_resource_child WHERE drain_json IS NULL LIMIT 1`,
            ).toEqual([]);
            yield* fs.writeFileString(
              evidence + "/native-results.json",
              json({
                approvedAtMs,
                originalDeadlineAtMs,
                originalDispatch: f.request,
                originalBudget: budget,
                initialized: first,
                assignment: second,
                children,
                calls,
                captured,
              }),
            );
            yield* assertChildrenDrained(children);
            yield* workspace.verifyRetained(snapshot, physical, setup);
            const verifyJoined = (
              _receipt: DispatchJournal.ProjectTeamDispatchStageReceipt,
              original: typeof snapshot,
            ) =>
              Effect.gen(function* () {
                expect(original.intent).toEqual(snapshot.intent);
                const retained = yield* f.sql<{
                  operation_id: string;
                  status: string;
                  terminal_json: string;
                }>`SELECT operation_id,status,
                CASE WHEN length(CAST(terminal_json AS BLOB))<=262144 THEN terminal_json ELSE NULL END AS terminal_json
                FROM project_team_pi_operation WHERE binding_id=${f.binding.recordId} ORDER BY operation_ordinal LIMIT 3`;
                expect(retained.map((row) => [row.operation_id, row.status])).toEqual([
                  [f.request.initializeOperationId, "settled"],
                  [f.request.assignmentOperationId, "settled"],
                ]);
                expect(
                  retained.map((row) => canonicalProjectWorkPayload(JSON.parse(row.terminal_json))),
                ).toEqual([
                  canonicalProjectWorkPayload(first.terminal),
                  canonicalProjectWorkPayload(second.terminal),
                ]);
                expect(
                  yield* f.sql`SELECT unit FROM project_task_resource_child WHERE drain_json IS NULL LIMIT 1`,
                ).toEqual([]);
                const ownedWorkspace = yield* f.sql<{
                  receipt_json: string;
                }>`SELECT CASE WHEN length(CAST(receipt_json AS BLOB))<=262144 THEN receipt_json ELSE NULL END AS receipt_json
                FROM project_team_workspace_receipt WHERE dispatch_id=${f.request.dispatchId} LIMIT 2`;
                expect(ownedWorkspace).toHaveLength(1);
                expect(
                  ownedWorkspace.map((row) =>
                    canonicalProjectWorkPayload(JSON.parse(row.receipt_json)),
                  ),
                ).toEqual([canonicalProjectWorkPayload(physical)]);
                const ownedSetup = yield* f.sql<{
                  receipt_json: string;
                }>`SELECT CASE WHEN length(CAST(receipt_json AS BLOB))<=262144 THEN receipt_json ELSE NULL END AS receipt_json
                FROM project_team_setup_process WHERE setup_id=${f.request.setupId} LIMIT 2`;
                expect(
                  ownedSetup.map((row) =>
                    canonicalProjectWorkPayload(JSON.parse(row.receipt_json)),
                  ),
                ).toEqual([canonicalProjectWorkPayload(setup)]);
              }).pipe(
                Effect.mapError(
                  () =>
                    new ProjectTeamDispatchJournalError({
                      reason: "Native joined evidence changed",
                    }),
                ),
              );
            const settling = yield* makeProjectTeamDispatchJournal({
              environmentId: "environment",
              maximumEnvironmentModelCalls: 4,
              verifyStage: verifyJoined,
              verifySettlement: verifyJoined,
            });
            snapshot = yield* settling.readRetained(
              (yield* settling.settleAfterJoined(snapshot.fence, {
                receiptId: "native-smoke-joined",
                stage: "settled",
                evidence: { worker: "joined", setup: "skipped", transport: "drained" },
              })).fence.dispatchId,
            );
            const state = yield* readCurrentState(f.sql, projectId);
            const binding = state.foundationRecords?.find(
              (row) => row.kind === "run-binding" && row.recordId === f.binding.recordId,
            );
            const task = state.tasks.find((row) => row.taskId === f.binding.taskId);
            if (binding?.kind !== "run-binding" || !task)
              return yield* Effect.die("Original verification target missing");
            expect(binding.status).toBe("settled");
            const principal = { actor: { kind: "human" as const, id: "fixture-human" } };
            const selection = yield* decodeNativeVerificationSelection({
              jobId: "native-node-version-smoke",
              projectId,
              taskId: task.taskId,
              expectedRevision: state.revision,
              expectedTaskRevision: task.revision,
              specRevision: task.specRevision,
              planRevision: binding.planRevision,
              bindingId: binding.recordId,
              expectedBindingRevision: binding.revision,
              generation: binding.generation,
              criterionIds: state.criteria
                .filter((row) => row.taskId === task.taskId)
                .map((row) => row.criterionId),
              command: {
                executable: "/runtime/node",
                argv: ["--version"],
                environment: "clean",
                limits: { maxDurationMs: 20000, maxOutputBytes: 4096 },
              },
            });
            const preparation = yield* makeProjectWorkVerificationPreparationRoot({
              environmentId: "environment",
              maximumEnvironmentModelCalls: 4,
              assertHumanCurrent: (actual, selectedProject) =>
                canonicalProjectWorkPayload(actual) === canonicalProjectWorkPayload(principal) &&
                selectedProject === projectId
                  ? Effect.void
                  : Effect.fail(
                      new ProjectWorkVerificationPreparationError({
                        reason: "Native human request changed",
                      }),
                    ),
            }).pipe(Effect.provide(physicalServices));
            const prepared = yield* preparation.prepare(selection, principal);
            const auth = yield* Authorization.ProjectTeamAuthorization;
            const gates = yield* makeProjectWorkVerificationGate({
              environmentId: "environment",
              maximumEnvironmentModelCalls: 4,
            });
            const trust = (selected: typeof selection) =>
              ProjectWorkVerificationApproval.of({
                selection: selected,
                receipt: prepared,
                assertCurrent: (current, duplicate) =>
                  gates.assertCurrent(current, prepared, selected, duplicate).pipe(
                    Effect.mapError(
                      () =>
                        new ProjectWorkVerificationGateError({
                          reason: "Native original approval target audit failed",
                        }),
                    ),
                  ),
              });
            const human = {
              actor: principal.actor,
              source: { kind: "web" as const, id: "fixture-browser" },
              recordedAt: DateTime.formatIso(yield* DateTime.now),
            };
            const decodeIntent = Schema.decodeUnknownEffect(ProjectTeamWriteIntent);
            yield* f.repository.execute(
              yield* auth
                .intent(
                  principal,
                  yield* decodeIntent({
                    ...selection,
                    type: "project-team.verification.propose",
                    commandId: "native-verification-propose",
                  }),
                  human,
                  false,
                )
                .pipe(Effect.provideService(ProjectWorkVerificationApproval, trust(selection))),
            );
            const proposed = yield* readCurrentState(f.sql, projectId);
            const gate = proposed.foundationRecords?.find(
              (row) => row.kind === "gate" && row.verificationJobId === selection.jobId,
            );
            if (gate?.kind !== "gate")
              return yield* Effect.die("Native verification proposal absent");
            yield* f.repository.execute(
              yield* auth
                .intent(
                  principal,
                  yield* decodeIntent({
                    type: "project-team.gate.respond",
                    commandId: "native-verification-approve",
                    projectId,
                    taskId: task.taskId,
                    expectedRevision: proposed.revision,
                    expectedTaskRevision: task.revision,
                    specRevision: selection.specRevision,
                    planRevision: selection.planRevision,
                    gateId: gate.recordId,
                    expectedGateRevision: gate.revision,
                    response: "approved",
                  }),
                  human,
                  false,
                )
                .pipe(
                  Effect.provideService(
                    ProjectWorkVerificationApproval,
                    trust({ ...selection, expectedRevision: proposed.revision }),
                  ),
                  Effect.provideService(
                    ProjectWorkVerificationRequest,
                    ProjectWorkVerificationRequest.of({
                      assertCurrent: (actual, selectedProject, purpose) =>
                        canonicalProjectWorkPayload(actual) ===
                          canonicalProjectWorkPayload(principal) &&
                        selectedProject === projectId &&
                        purpose === "write"
                          ? Effect.void
                          : Effect.fail(
                              new ProjectWorkVerificationRequestError({
                                reason: "Native fixture permission changed",
                              }),
                            ),
                    }),
                  ),
                ),
            );
            const host = yield* makeProjectWorkVerificationExecutionHost({
              environmentId: "environment",
              maximumEnvironmentModelCalls: 4,
              protectedRoots: [evidence],
              nativeAdmission: Effect.void,
            }).pipe(
              Effect.provide(Layer.merge(physicalServices, ProjectWorkEventBusLive)),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed),
            );
            const verification = yield* makeProjectWorkVerificationExecution({
              ...host,
              environmentId: "environment",
            });
            yield* verification.sweep;
            const result = yield* host.journal.readResult(selection.jobId);
            yield* fs.writeFileString(evidence + "/verification-result.json", json(result));
            expect(result).toMatchObject({ outcome: "success", exitCode: 0, outputComplete: true });
            if (!result?.drain) return yield* Effect.die("Actual verifier drain absent");
            expect(result.drain.memoryBytes).toBe(2147483648);
            expect(result.drain.childExitCode).toBe(0);
            expect(result.drain.kernel).toBe("removed");
            expect(result.drain.swapBytes).toBe(0);
            expect(result.drain.oomGroup).toBe(1);
            expect(
              yield* f.sql`SELECT unit FROM project_task_resource_child WHERE drain_json IS NULL LIMIT 1`,
            ).toEqual([]);
            expect(
              yield* f.sql`SELECT deadline_at_ms,memory_bytes FROM project_task_resource_budget LIMIT 2`,
            ).toEqual(budget);
            const verifierOwners = captured.filter((item) => item.unit === result.drain?.unit);
            expect(verifierOwners.map((item) => item.kind)).toEqual([
              "launcher",
              "owner",
              "started",
            ]);
            expect(verifierOwners.map((item) => item.pid)).toEqual([
              result.drain.launcherPid,
              result.drain.ownerPid,
              result.drain.childPid,
            ]);
            for (const item of verifierOwners) {
              const stat = yield* fs.readFileString(`/proc/${item.pid}/stat`).pipe(Effect.option);
              if (Option.isSome(stat))
                expect(stat.value.slice(stat.value.lastIndexOf(") ") + 2).split(" ")[19]).not.toBe(
                  item.startTime,
                );
            }
            expect(yield* fs.exists(result.drain.cgroup)).toBe(false);
            const artifacts = yield* makeProjectWorkArtifacts({
              environmentId: "environment",
              maximumArtifactBytes: 4096,
            });
            const stdout = yield* artifacts.readRetained(result.stdout.artifactId);
            const stderr = yield* artifacts.readRetained(result.stderr.artifactId);
            if (!stdout || !stderr)
              return yield* Effect.die("Native verification output artifacts absent");
            const { bytes: stdoutBytes, ...stdoutReceipt } = stdout;
            const { bytes: stderrBytes, ...stderrReceipt } = stderr;
            expect(stdoutReceipt).toEqual(result.stdout);
            expect(stderrReceipt).toEqual(result.stderr);
            const stdoutText = new TextDecoder().decode(stdoutBytes);
            expect(stdoutText).toBe(process.version + "\n");
            expect(stderrBytes.byteLength).toBe(0);
            yield* fs.writeFileString(
              evidence + "/verification-results.json",
              json({
                selection,
                prepared,
                result,
                stdoutText,
                captured: verifierOwners,
                originalBudget: budget,
                originalDeadlineAtMs,
                qualification:
                  "Actual clean target/executable/human-approved node --version launch, accounting and drain smoke; not implementation validation. Test-local human permission and repository permit.",
              }),
            );
          }),
        ),
      90000,
    );
  },
);

it.effect(
  "joined managed context survives session replacement, compaction and replay within original authority",
  () =>
    scoped(
      Effect.gen(function* () {
        // The broker uses wall time; keep it aligned with the Effect test clock.
        let wallClock = Date.parse(at) + 1;
        const wallClockSpy = vi.spyOn(Date, "now").mockImplementation(() => wallClock);
        yield* Effect.addFinalizer(() => Effect.sync(() => wallClockSpy.mockRestore()));
        const f = yield* dispatchedRuntimeFixture();
        const gateway = yield* ProjectWorkGateway;
        const human = { kind: "human" as const, id: "joined-human" };
        const source = { kind: "web" as const, id: "joined-browser" };
        const decision = yield* decodeMemorySourceDecision({
          decisionId: "joined-decision",
          projectId,
          title: "Preserve assignment provenance",
          body: "Keep the approved scope and original budget through compaction.",
          state: "proposed",
          revision: 0,
          createdAt: at,
          updatedAt: at,
        });
        yield* gateway.write(
          {
            type: "project-work.decision.propose",
            commandId: CommandId.make("joined-propose"),
            projectId,
            decision,
            proposedAt: at,
          },
          human,
          source,
          { actor: human },
        );
        yield* gateway.write(
          {
            type: "project-work.decision.accept",
            commandId: CommandId.make("joined-accept"),
            projectId,
            decisionId: decision.decisionId,
            acceptedAt: at,
          },
          human,
          source,
          { actor: human },
        );
        const state = yield* readCurrentState(f.sql, projectId);
        const gate = state.foundationRecords?.find(
          (r) => r.kind === "gate" && r.taskId === f.binding.taskId && r.gate === "plan",
        );
        if (gate?.kind !== "gate") return yield* Effect.die("Missing approved joined plan");
        yield* f.repository.execute(
          yield* decodeRequiredFoundation({
            type: "project-work.foundation.commit",
            projectId,
            commandId: "joined-question",
            expectedRevision: state.revision,
            attribution,
            committedAt: at,
            records: [
              {
                kind: "question",
                projectId,
                recordId: "joined-question",
                revision: 0,
                generation: 0,
                updatedAt: at,
                status: "pending",
                taskId: f.binding.taskId,
                senderId: f.binding.memberId,
                targetGateId: gate.recordId,
                targetRevision: gate.revision,
                body: "Should a later task expand the scope? Await a human answer.",
                choices: [],
              },
            ],
          }),
        );
        const before = yield* f.reader.readRequired(f.snapshot);
        expect(before.required.tasks[0]?.task.specification).toMatchObject({
          scopeIn: "Task",
          scopeOut: "Other tasks",
        });
        expect(before.required.tasks[0]?.plan).toMatchObject({
          content: "Implement the bounded scope and verify the requirement",
        });
        expect(before.required.approvals).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ gate: "plan", status: "approved" }),
            expect.objectContaining({ gate: "specification", status: "approved" }),
          ]),
        );
        expect(before.required.decisions).toEqual([
          expect.objectContaining({ decisionId: decision.decisionId, state: "accepted" }),
        ]);
        expect(before.required.questions).toEqual([
          expect.objectContaining({ recordId: "joined-question", status: "pending" }),
        ]);
        const budget = yield* f.sql`SELECT * FROM project_team_model_budget`;
        yield* f.fs.writeFileString(
          f.options.agentDirectory + "/auth.json",
          json({ "command-code": { type: "api_key", key: "synthetic-joined-key" } }),
        );
        let executions = 0;
        let calls = 0;
        const transfers: Array<{
          kind: string;
          context: string;
          prompt: string;
          resume: string | null;
        }> = [];
        // Only the worker byte transport and its synthetic owner/drain are controlled.
        // Session protocol, authorization, broker, accounting and terminal persistence run unchanged.
        const processSpy = vi
          .spyOn(ManagedProcess, "acquirePiManagedProcess")
          .mockImplementation((launch, persistence) =>
            Effect.gen(function* () {
              executions++;
              if (!persistence) return yield* Effect.die("Missing durable process callbacks");
              const allocation = persistence.allocation;
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
              yield* persistence.claimActivation(allocation);
              yield* persistence.beforeStart(owner);
              const output = yield* Queue.unbounded<Uint8Array | null>();
              const exited = yield* Deferred.make<ManagedProcess.PiManagedDrain>();
              const drain = {
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
              };
              let pending = "";
              let sequence = 0;
              let envelope:
                | Pick<PiWorkerFrame, "workerId" | "generation" | "operationId" | "operationKind">
                | undefined;
              let bootstrap:
                | Extract<ReturnType<typeof decodePiParentFrame>["message"], { type: "bootstrap" }>
                | undefined;
              const parts = new Map<string, Buffer[]>();
              const ended = new Set<string>();
              const emit = (message: PiWorkerFrame["message"]) =>
                Queue.offer(
                  output,
                  Buffer.from(
                    json({ version: 1, ...envelope, sequence: sequence++, message }) + "\n",
                  ),
                );
              const native = {
                sessionId: "joined-session",
                sessionReference: "sessions/joined.jsonl",
                leafId: "joined-initialize",
                persisted: true,
              };
              const persistLeaf = Effect.fn("joinedTransport.persistLeaf")(function* (
                leafId: string,
                text: string,
              ) {
                const path = launch.nativeStateRoot + "/" + native.sessionReference;
                yield* f.fs.makeDirectory(launch.nativeStateRoot + "/sessions", {
                  recursive: true,
                });
                const prior = (yield* f.fs.exists(path))
                  ? yield* f.fs.readFileString(path)
                  : json({
                      type: "session",
                      version: 3,
                      id: native.sessionId,
                      timestamp: at,
                      cwd: "/workspace",
                    }) + "\n";
                yield* f.fs.writeFileString(
                  path,
                  prior +
                    json({
                      type: "message",
                      id: leafId,
                      parentId: bootstrap?.native?.leafId ?? null,
                      timestamp: at,
                      message: {
                        role: "user",
                        content: [{ type: "text", text }],
                        timestamp: Date.parse(at),
                      },
                    }) +
                    "\n",
                );
                return { ...native, leafId };
              });
              const send = Effect.fn("joinedTransport.send")(function* (bytes: Uint8Array) {
                pending += Buffer.from(bytes).toString("utf8");
                for (;;) {
                  const newline = pending.indexOf("\n");
                  if (newline < 0) break;
                  const frame = decodePiParentFrame(pending.slice(0, newline));
                  pending = pending.slice(newline + 1);
                  envelope = {
                    workerId: frame.workerId,
                    generation: frame.generation,
                    operationId: frame.operationId,
                    operationKind: frame.operationKind,
                  };
                  const message = frame.message;
                  if (message.type === "bootstrap") bootstrap = message;
                  if (message.type === "transfer-chunk") {
                    const chunks = parts.get(message.transferId) ?? [];
                    chunks.push(Buffer.from(message.data, "base64"));
                    parts.set(message.transferId, chunks);
                  }
                  if (message.type === "transfer-end") {
                    ended.add(message.transferId);
                    if (
                      !bootstrap ||
                      !ended.has(bootstrap.context.transferId) ||
                      (bootstrap.prompt && !ended.has(bootstrap.prompt.transferId))
                    )
                      continue;
                    const text = (id: string) =>
                      Buffer.concat(parts.get(id) ?? []).toString("utf8");
                    const context = text(bootstrap.context.transferId);
                    const prompt = bootstrap.prompt ? text(bootstrap.prompt.transferId) : "";
                    transfers.push({
                      kind: frame.operationKind!,
                      context,
                      prompt,
                      resume: bootstrap.native?.leafId ?? null,
                    });
                    yield* emit({
                      type: "ready",
                      actualCwd: "/workspace",
                      native: bootstrap.native ?? native,
                    });
                    if (frame.operationKind === "initialize") {
                      yield* emit({
                        type: "initialized",
                        native: yield* persistLeaf(native.leafId, context),
                      });
                    } else {
                      yield* emit({
                        type:
                          frame.operationKind === "compact" ? "compaction_start" : "agent_start",
                        lifecycleId: 1,
                      });
                      yield* emit({
                        type: "request",
                        requestId: 1,
                        lifecycleId: 1,
                        body: json({
                          model,
                          messages: [
                            { role: "system", content: context },
                            { role: "user", content: prompt || "Compact within approved scope" },
                          ],
                          max_tokens: 512,
                          stream: true,
                          stream_options: { include_usage: true },
                        }),
                      });
                    }
                  }
                  if (message.type === "chunk")
                    yield* emit({
                      type: "ack",
                      requestId: message.requestId,
                      chunkSequence: frame.sequence,
                    });
                  if (message.type === "end") {
                    const context = Buffer.concat(parts.get("context") ?? []).toString("utf8");
                    const leaf = yield* persistLeaf(
                      frame.operationKind === "compact" ? "joined-compact" : "joined-assignment",
                      context,
                    );
                    if (frame.operationKind === "compact") {
                      yield* emit({ type: "compaction_end", lifecycleId: 1 });
                      yield* emit({ type: "compacted", lifecycleId: 1, native: leaf });
                    } else {
                      yield* emit({
                        type: "sdk-event",
                        lifecycleId: 1,
                        event: { type: "message_start", entryId: "message-1", role: "assistant" },
                      });
                      yield* emit({
                        type: "sdk-event",
                        lifecycleId: 1,
                        event: { type: "message_end", entryId: "message-1", role: "assistant" },
                      });
                      yield* emit({
                        type: "sdk-event",
                        lifecycleId: 1,
                        event: { type: "assistant_result", stopReason: "stop" },
                      });
                      yield* emit({ type: "native", lifecycleId: 1, native: leaf });
                      yield* emit({ type: "agent_end", lifecycleId: 1 });
                      yield* emit({ type: "agent_settled", lifecycleId: 1 });
                    }
                    yield* emit({ type: "operation_settled", lifecycleId: 1, outcome: "success" });
                    yield* emit({ type: "done" });
                  }
                }
              });
              const finish = Effect.gen(function* () {
                yield* Queue.offer(output, null);
                if (persistence.afterDrain) yield* persistence.afterDrain(drain);
                yield* Deferred.succeed(exited, drain);
              });
              return {
                owner,
                start: Effect.succeed(99999997),
                send: (bytes: Uint8Array) => send(bytes).pipe(Effect.orDie),
                stdout: Stream.fromQueue(output).pipe(Stream.takeWhile((chunk) => chunk !== null)),
                stderr: Stream.empty,
                endInput: finish,
                awaitExit: Deferred.await(exited),
                stop: finish.pipe(Effect.as(drain)),
              } satisfies ManagedProcess.PiManagedProcess;
            }),
          );
        yield* Effect.addFinalizer(() => Effect.sync(() => processSpy.mockRestore()));
        const options = {
          ...f.options,
          transport: async () => {
            calls++;
            expect(calls).toBeLessThanOrEqual(2);
            return new Response(
              [
                {
                  model,
                  choices: [
                    { index: 0, delta: { content: "Within approved scope" }, finish_reason: null },
                  ],
                },
                { model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
                {
                  model,
                  choices: [],
                  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
                },
              ]
                .map((entry) => `data: ${json(entry)}\n\n`)
                .join("") + "data: [DONE]\n\n",
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        };
        const create = Effect.fn("joined.createRuntime")(function* () {
          return yield* (yield* makePiManagedRuntimeLive(options)).forInstance({
            instanceId: providerInstanceId,
            enabled: true,
            configuration: {},
          });
        });
        const instance = yield* create();
        const initialized = yield* instance.prepareOperation(
          { threadId, kind: "initialize", operationId: f.request.initializeOperationId },
          () => Effect.void,
        );
        expect((yield* initialized.run).terminal.outcome).toBe("success");
        const sessionReceipts = yield* makeProjectTeamSessionReceipts({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
        });
        const journal = yield* makeProjectTeamDispatchJournal({
          environmentId: "environment",
          maximumEnvironmentModelCalls: 4,
          verifyStage: (receipt, original) =>
            Effect.gen(function* () {
              expect(receipt.evidence.bindingId).toBe(original.intent.request.git.runId);
              expect(yield* sessionReceipts.readInitialization(original)).toBeDefined();
              if (receipt.stage === "assignment-observed")
                expect(yield* sessionReceipts.readAssignment(original)).toBeDefined();
            }).pipe(
              Effect.mapError(
                () =>
                  new ProjectTeamDispatchJournalError({ reason: "Joined session receipt missing" }),
              ),
            ),
        });
        const authority = yield* readCurrentState(f.sql, projectId);
        let snapshot = f.snapshot;
        for (const stage of ["session-bound", "assignment-intent"] as const)
          snapshot = yield* journal.readRetained(
            (yield* journal.advanceStage(snapshot.fence, {
              receiptId: "joined-" + stage,
              stage,
              evidence: { bindingId: f.binding.recordId },
            })).fence.dispatchId,
          );
        const assigned = yield* instance.prepareOperation(
          {
            threadId,
            kind: "prompt",
            operationId: f.request.assignmentOperationId,
            prompt: f.request.assignment,
          },
          () => Effect.void,
        );
        const assignmentRun = yield* assigned.run.pipe(Effect.result);
        expect(
          assignmentRun,
          json({
            operations: yield* f.sql`SELECT terminal_json FROM project_team_pi_operation`,
            charges: yield* f.sql`SELECT * FROM project_team_model_request`,
          }),
        ).toMatchObject({ _tag: "Success" });

        snapshot = yield* journal.readRetained(
          (yield* journal.advanceStage(snapshot.fence, {
            receiptId: "joined-observed",
            stage: "assignment-observed",
            evidence: { bindingId: f.binding.recordId },
          })).fence.dispatchId,
        );
        wallClock += 100;
        yield* TestClock.adjust(100);
        const charged = yield* f.reader.readRequired(snapshot);
        expect(charged.required.remaining).toMatchObject({
          rootUsedTokens: 12,
          attemptUsedTokens: 12,
          rootRemainingTokens: before.required.frozenLimits.maximumTokens - 12,
          outstandingRequests: 0,
        });
        const replacement = yield* create();
        const operations = yield* makeProjectTeamPiOperations({ environmentId: "environment" });
        const supplied = {
          threadId,
          kind: "compact" as const,
          requestId: MessageId.make("joined-compact"),
        };
        const boundary = yield* operations.readCompaction(
          { providerInstanceId, threadId },
          supplied,
        );
        const request = { ...supplied, operationId: boundary.operationId };
        const compact = yield* replacement.prepareOperation(request, () => Effect.void);
        const terminal = (yield* compact.run).terminal;
        expect(terminal.outcome).toBe("success");
        expect(transfers.map((t) => [t.kind, t.resume])).toEqual([
          ["initialize", null],
          ["prompt", "joined-initialize"],
          ["compact", "joined-assignment"],
        ]);
        expect(transfers[1]?.prompt).toContain(f.request.assignment);
        expect(transfers[2]?.context).toContain(charged.text);
        const intent = yield* f.sql<{
          intent_json: string;
        }>`SELECT intent_json FROM project_team_pi_operation WHERE operation_id=${boundary.operationId}`;
        expect(decodeRequiredJson(intent[0]!.intent_json)).toMatchObject({
          compaction: {
            predecessorOperationId: f.request.assignmentOperationId,
            contextProvenanceSha256: NodeCrypto.createHash("sha256")
              .update(json(charged.provenance))
              .digest("hex"),
            contextTextSha256: NodeCrypto.createHash("sha256")
              .update(transfers[2]!.context)
              .digest("hex"),
          },
        });
        const after = yield* f.reader.readRequired(snapshot);
        for (const current of [charged, after]) {
          expect(current.required).toMatchObject({
            projectId,
            taskId: f.binding.taskId,
            runId: f.binding.recordId,
            attemptId: f.binding.attemptId,
            generation: f.binding.generation,
          });
          expect(current.required.originalAssignment).toBe(f.request.assignment);
          expect(current.required.role).toEqual(before.required.role);
          expect(current.required.member).toEqual(before.required.member);
          expect(current.required.tasks).toEqual(before.required.tasks);
          expect(current.required.approvals).toEqual(before.required.approvals);
          expect(current.required.decisions).toEqual(before.required.decisions);
          expect(current.required.questions).toEqual(before.required.questions);
          expect(current.required.questions[0]?.answer).toBeUndefined();
          expect(current.required.frozenLimits).toEqual(before.required.frozenLimits);
          expect(current.required.originalRootCaps).toEqual(before.required.originalRootCaps);
          expect(current.provenance.recordIds).toEqual(before.provenance.recordIds);
          expect(current.provenance.decisions).toEqual(before.provenance.decisions);
        }
        expect(after.required.remaining).toMatchObject({
          rootUsedTokens: 24,
          attemptUsedTokens: 24,
          rootRemainingTokens: before.required.frozenLimits.maximumTokens - 24,
          outstandingRequests: 0,
        });
        expect(after.required.remaining.rootRemainingDurationMs).toBe(
          charged.required.remaining.rootRemainingDurationMs,
        );
        expect(after.required.remaining.rootRemainingDurationMs).toBe(
          before.required.remaining.rootRemainingDurationMs - 100,
        );
        expect(after.required.remaining.attemptRemainingDurationMs).toBe(
          before.required.remaining.attemptRemainingDurationMs - 100,
        );
        expect(after.required.remaining.attemptRemainingDurationMs).toBe(
          charged.required.remaining.attemptRemainingDurationMs,
        );
        expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toEqual(budget);
        const operationLimits =
          yield* f.sql`SELECT maximum_tokens,deadline_at_ms FROM project_team_pi_operation ORDER BY operation_ordinal`;
        expect(operationLimits).toHaveLength(3);
        expect(operationLimits[0]?.maximum_tokens).toBe(before.required.frozenLimits.maximumTokens);
        expect(operationLimits[0]?.deadline_at_ms).toBeLessThanOrEqual(
          before.required.frozenLimits.deadlineAtMs,
        );
        expect(operationLimits.slice(1)).toEqual(
          Array.from({ length: 2 }, () => ({
            maximum_tokens: before.required.frozenLimits.maximumTokens,
            deadline_at_ms: before.required.frozenLimits.deadlineAtMs,
          })),
        );
        const rows =
          yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_ordinal`;
        const charges =
          yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`;
        const allocations = f.allocations;
        const replay = yield* (yield* create()).prepareOperation(request, () =>
          Effect.die("Replay emitted execution"),
        );
        expect((yield* replay.run).terminal).toEqual(terminal);
        expect(replay.replayHeadOperationId).toBe(terminal.operation.operationId);
        expect(yield* f.reader.readRequired(snapshot)).toEqual(after);
        expect(yield* readCurrentState(f.sql, projectId)).toEqual(authority);
        expect(
          yield* f.sql`SELECT * FROM project_team_pi_operation ORDER BY operation_ordinal`,
        ).toEqual(rows);
        expect(
          yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`,
        ).toEqual(charges);
        expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toEqual(budget);
        expect({ executions, calls, allocations: f.allocations }).toEqual({
          executions: 3,
          calls: 2,
          allocations,
        });
      }),
    ),
);

for (const compactProof of [
  undefined,
  "joinedNoMemory",
  "beforeAcquire",
  "beforeStart",
  "afterAwait",
  "successorReplay",
  "cleanupReturn",
  "returnRevoked",
  "returnExpired",
  "returnWorkspace",
  "returnSource",
  "returnSourceAfterWrite",
  "returnWorkspaceAfterWrite",
  "returnCancel",
  "memoryAdmission",
  "memoryAccounting",
  "memoryRootLing1000",
  "memoryRootLing64000",
  "memoryRootLunaControl",
  "memoryRootHardForged",
  "memoryRootHardControl",
  "memoryRootMissingGrant",
  "memoryRootDescendantGrant",
  "memorySubscriptionPiFirst",
  "memorySubscriptionMemoryFirst",
  "memorySubscriptionUnknown",
  "memorySubscriptionPiUnknown",
  "memorySharedRoot",
  "memoryPipeline",
  "memoryLiquidPipeline",
  "memoryLiquidAccounting",
  "memoryLiquidConfiguration",
  "memoryLiquidIdentity",
  "memoryServerExtract",
  "memoryServerEmbed",
  "memoryServerQuery",
  "memoryServerCurrent",
  "memoryServerQueryCurrent",
  "memoryForwardExtract",
  "memoryForwardEmbed",
  "memoryForwardIndex",
  "memoryForwardQueryEmbed",
  "memoryForwardQuerySearch",
  "memoryCompanionIndex",
  "memoryCompanionSharedRoot",
  "memoryCompanionQuery",
  "memoryCompanionRecovery",
  "memoryCompanionCapture",
  "memoryCompanionExpired",
  "memoryCompanionDelete",
  "memoryFailure",
  "memorySourceJoinedRecovery",
  "memorySecret",
  "memoryEmbeddingSecret",
  "memoryCleanup",
  "memoryCleanupGuards",
  "memoryHumanRetraction",
  "memoryQuery",
  "memoryQueryPipeline",
  "memoryQueryActiveDrain",
  "memoryQueryDrainCapacity",
  "memoryQueryJoinedRecovery",
  "memoryQueryInterruptedRecovery",
  "memoryQueryShared",
  "memoryCompanionSharedQuery",
  "memoryQuerySharedProject",
  "memoryQuerySharedNone",
  "memoryQuerySharedRevokeCache",
  "memoryQuerySharedRevokeDelivery",
  "memoryQuerySharedRevokeBeforeSearch",
  "memoryQuerySharedDeleteCache",
  "memoryQuerySharedTombstoneCache",
  "memoryQuerySharedSupersedeCache",
  "memoryQueryModelUnknown",
  "memoryQuerySearchUnknown",
  "memoryQueryGuards",
  "memoryQueryNoGrant",
  "memoryQueryNoAccess",
  "memoryQueryBudget",
  "memoryQuerySecret",
  "memoryQueryMixed",
] as const)
  it.effect(
    compactProof?.startsWith("memoryRoot")
      ? `qualifies memory settlement against original root authority: ${compactProof}`
      : compactProof?.startsWith("memorySubscription")
        ? `settles memory and monitored Pi usage atomically: ${compactProof}`
        : (compactProof?.includes("Shared") && compactProof.includes("Query")) ||
            compactProof?.startsWith("memoryQueryShared")
          ? `shared semantic query preserves recipient accounting and exact owner authority: ${compactProof}`
          : compactProof === undefined
            ? "managed compact transfers current required context after durable association and replays without another execution"
            : compactProof === "memoryAdmission"
              ? "retains exact memory selection against the executing operation before processing and replays after terminal"
              : compactProof === "memoryAccounting" || compactProof === "memoryLiquidAccounting"
                ? `accounts memory and ordinary stages against the same executing operation and shared capacity: ${compactProof}`
                : compactProof === "memorySharedRoot"
                  ? "reads shared root usage outside the charged child binding page without assigning parent charges"
                  : compactProof === "memoryPipeline"
                    ? "processes an exact admitted source through shared model accounting and the configured index consumer"
                    : compactProof === "memoryFailure"
                      ? "retains a committed memory selection and unknown charge until authenticated local drain without resend"
                      : compactProof === "memorySecret"
                        ? "rejects a newly learned escaped source secret before memory extraction reservation"
                        : compactProof === "memoryEmbeddingSecret"
                          ? "rejects newly learned escaped embedding text before its memory reservation"
                          : compactProof === "memoryCleanup"
                            ? "discovers exact superseded decision cleanup for the executing task without funding old indexing"
                            : compactProof === "memoryHumanRetraction"
                              ? "funds exact authenticated human memory retraction cleanup without model calls or artifact deletion"
                              : compactProof === "memoryCleanupGuards"
                                ? "rejects forged decision lineage and immutable cleanup job changes before admission or backend"
                                : compactProof === "memoryQuery"
                                  ? "admits an explicit semantic query through the executing task bridge before forward stages"
                                  : compactProof === "memoryQueryPipeline"
                                    ? "consumes an exact task-funded semantic query and serves audited completed context without new calls"
                                    : compactProof === "memoryQueryMixed"
                                      ? "retains current semantic context when completed search also returns a genuinely superseded observation"
                                      : compactProof === "memoryQueryGuards"
                                        ? "denies stale task scope and disabled or ownerless semantic query admission without partial effects"
                                        : compactProof === "memoryQueryNoGrant"
                                          ? "denies semantic query admission without the original frozen write intersection"
                                          : compactProof === "memoryQueryNoAccess"
                                            ? "denies semantic query admission for an original no-memory role"
                                            : compactProof === "memoryQueryBudget"
                                              ? "retains authenticated query failure when the original operation budget cannot fund embedding"
                                              : compactProof === "memoryQuerySecret"
                                                ? "rejects a newly learned escaped query credential before embedding reservation"
                                                : compactProof === "memoryQueryModelUnknown"
                                                  ? "retains an unknown query embedding charge until authenticated drain without resend"
                                                  : compactProof === "memoryQuerySearchUnknown"
                                                    ? "settles an uncertain query search only after its exact authenticated late drain"
                                                    : compactProof === "successorReplay"
                                                      ? "retained compact replay preserves the latest successful native head without another execution"
                                                      : compactProof?.startsWith("memoryServer")
                                                        ? `production memory model forwarding fences the final wait: ${compactProof}`
                                                        : compactProof?.startsWith("memoryForward")
                                                          ? `captured runtime denies ${compactProof} before transport without holding SQL`
                                                          : `compact fences protected context at ${compactProof} while permitting accounting and clock drift`,
    () =>
      scoped(
        Effect.gen(function* () {
          const memoryRoot = compactProof?.startsWith("memoryRoot") === true;
          const hardRoot = compactProof?.startsWith("memoryRootHard") === true;
          const forgedRoot = compactProof === "memoryRootHardForged";
          const memoryRootDenied =
            forgedRoot ||
            compactProof === "memoryRootMissingGrant" ||
            compactProof === "memoryRootDescendantGrant";
          const lunaChild = compactProof === "memoryRootLunaControl" || forgedRoot;
          const childCeiling = compactProof === "memoryRootLing64000" ? 64_000 : 1000;
          let memoryRootChecked = false;
          const subscriptionMemory = compactProof?.startsWith("memorySubscription") === true;
          const memoryUnknown = compactProof === "memorySubscriptionUnknown";
          const piUnknown = compactProof === "memorySubscriptionPiUnknown";
          let subscriptionMemoryChecked = false;
          const liquidProof = compactProof?.startsWith("memoryLiquid") === true;
          const liquidDenied =
            compactProof === "memoryLiquidConfiguration" || compactProof === "memoryLiquidIdentity";
          const serverProof = compactProof?.startsWith("memoryServer") === true;
          const serverQuery = compactProof?.startsWith("memoryServerQuery") === true;
          const serverCurrent = serverProof && compactProof?.endsWith("Current");
          const serverDeny = serverProof && !serverCurrent;
          let forwardingAtServer = false;
          const forwardProof = compactProof?.startsWith("memoryForward") === true || serverDeny;
          const forwardQuery =
            compactProof?.startsWith("memoryForwardQuery") === true || (serverQuery && serverDeny);
          let forwardArmed = false;
          let forwardChecks = 0;
          let forwardDeniedObserved = false;
          let capturedMemoryOperation: ProjectMemoryOperation["Service"] | undefined;
          const forwardEntered = yield* Deferred.make<void>();
          const forwardRelease = yield* Deferred.make<void>();
          let memoryReady = false;
          const lateSecret = 'controlled-memory-"key\\tail';
          const companionProof = compactProof?.startsWith("memoryCompanion") === true;
          const pipelineProof =
            compactProof === "memoryPipeline" ||
            compactProof === "memoryLiquidPipeline" ||
            compactProof === "memoryServerCurrent" ||
            (forwardProof && !forwardQuery) ||
            compactProof === "memoryCompanionIndex" ||
            compactProof === "memoryCompanionSharedRoot";
          const sourceFailure =
            compactProof === "memoryFailure" || compactProof === "memorySourceJoinedRecovery";
          const memoryProof = compactProof?.startsWith("memory") === true;
          const accountingProof =
            memoryRoot ||
            subscriptionMemory ||
            compactProof === "memoryAccounting" ||
            compactProof === "memoryLiquidAccounting" ||
            compactProof === "memorySharedRoot";
          const humanRetraction =
            compactProof === "memoryHumanRetraction" || compactProof === "memoryCompanionDelete";
          const cleanupProof =
            compactProof === "memoryCleanup" ||
            compactProof === "memoryCleanupGuards" ||
            humanRetraction;
          let consumeMemory:
            | ((
                principal: Authorization.ProjectTeamPrincipal,
                effectId: string,
              ) => Effect.Effect<void, ProjectMemoryServiceError>)
            | undefined;
          let memoryExchanges = 0;
          let memoryBackendCalls = 0;
          let consumeQuery:
            | ((
                principal: Authorization.ProjectTeamPrincipal,
                id: string,
              ) => Effect.Effect<void, ProjectMemoryServiceError>)
            | undefined;
          let readQueryCache:
            | ((
                principal: Authorization.ProjectTeamPrincipal,
              ) => Effect.Effect<ProjectMemoryRetrieval | undefined, ProjectMemoryServiceError>)
            | undefined;
          const joinedRecovery =
            compactProof === "memoryQueryJoinedRecovery" ||
            compactProof === "memoryQueryInterruptedRecovery";
          const queryInterrupted = yield* Deferred.make<void>();
          const captureFailure = compactProof === "memoryCompanionCapture";
          const expiryFailure = compactProof === "memoryCompanionExpired";
          const startFailure = captureFailure || expiryFailure;
          const searchUnknown =
            compactProof === "memoryQuerySearchUnknown" ||
            compactProof === "memoryCompanionRecovery" ||
            startFailure;
          const queryRecovery =
            compactProof === "memoryQueryModelUnknown" || joinedRecovery || searchUnknown;
          const queryBudget = compactProof === "memoryQueryBudget";
          const querySecret = compactProof === "memoryQuerySecret";
          const sharedBeforeSearchDenied = compactProof === "memoryQuerySharedRevokeBeforeSearch";
          const sharedDeliveryDenied =
            compactProof === "memoryQuerySharedRevokeDelivery" || sharedBeforeSearchDenied;
          const queryNoForward = queryBudget || querySecret;
          const queryText = querySecret
            ? 'controlled-query-"secret\\tail'
            : "Which retained facts explain parser provenance?";
          const sharedQuery =
            serverQuery ||
            compactProof?.startsWith("memoryQueryShared") === true ||
            compactProof === "memoryCompanionSharedQuery";
          const sharedDenied =
            compactProof === "memoryQuerySharedProject" || compactProof === "memoryQuerySharedNone";
          const sharedOwnerId = ProjectId.make("shared-query-owner");
          let sharedSelection: ProjectTeamMemorySourceSelector | undefined;
          let sharedObservation: ProjectMemoryObservation | undefined;
          let sharedMemory: ReturnType<typeof makeProjectMemoryService> | undefined;
          const queryDenied =
            compactProof === "memoryQueryNoGrant" ||
            compactProof === "memoryQueryNoAccess" ||
            sharedDenied;
          const queryAdmissionOnly =
            compactProof === "memoryQuery" || compactProof === "memoryQueryGuards" || queryDenied;
          const queryMixed =
            compactProof === "memoryQueryMixed" || compactProof === "memoryCompanionQuery";
          const queryCache =
            (sharedQuery &&
              (!serverQuery || !serverDeny) &&
              !sharedDenied &&
              !sharedDeliveryDenied) ||
            compactProof === "memoryQueryPipeline" ||
            compactProof === "memoryQueryActiveDrain" ||
            compactProof === "memoryQueryDrainCapacity" ||
            compactProof === "memoryCompanionQuery" ||
            queryMixed;
          const queryForward =
            queryCache || queryRecovery || queryNoForward || sharedDeliveryDenied || forwardQuery;
          let activeQuery = false;
          let failedUsageOperationId: string | undefined;
          const queryDrains = new Set<string>();
          let memoryPipelineFailure = "";
          let memoryPipelineError: ProjectMemoryServiceError | undefined;
          const memoryDrains = new Set<string>();
          const releasedModelObservations: string[] = [];
          const observeModelDrain = (id: string) => {
            if (memoryDrains.size < 256) memoryDrains.add(id);
          };
          const queryGuard = yield* Effect.gen(function* () {
            return yield* ProjectWorkContentGuard;
          }).pipe(Effect.provide(ProjectWorkContentGuardLive));
          let queryConfiguration: ProjectMemoryProcessingConfiguration = {
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
              runtimeFiles: [{ source: "/controlled/python", target: "/runtime/python" }],
            },
          };
          let reconcileMemory:
            | ((id: string) => Effect.Effect<void, ProjectMemoryServiceError>)
            | undefined;
          let confirmMemoryDrain:
            | ProjectMemoryProcessingConsumerOptions["confirmModelTransportDrained"]
            | undefined;
          let restartMemoryConsumer: Effect.Effect<void, ProjectMemoryServiceError> | undefined;
          let recoverMemory: MemoryModelPorts.ProjectMemoryPorts["Service"]["recoverJoinedOperation"];
          const recoveryWakes: string[] = [];
          const queryCleanupQueued = yield* Deferred.make<string>();
          const queryCleanupRelease = yield* Deferred.make<void>();
          let delayedQueryCleanupRan = false;
          const delayedQueryCleanup = queryNoForward
            ? yield* Effect.gen(function* () {
                const id = yield* Deferred.await(queryCleanupQueued);
                yield* Deferred.await(queryCleanupRelease);
                delayedQueryCleanupRan = true;
                if (!reconcileMemory)
                  return yield* Effect.die("Delayed query cleanup port missing");
                yield* reconcileMemory(id);
              }).pipe(Effect.forkChild)
            : undefined;

          let joinedTerminal: SessionRuntime.PiSessionTerminal | undefined;
          const returnEntered = yield* Deferred.make<void>();
          const returnProof = compactProof?.startsWith("return") === true;
          const selectedSkill = compactProof?.startsWith("returnSource")
            ? yield* (yield* ManagedSkills.ManagedSkillRepository).createGlobal({
                expectedRevision: 0,
                content: {
                  key: ManagedSkillKey.make("compact-return"),
                  name: "Compact Return",
                  body: "Selected original source.",
                },
              })
            : undefined;
          let finalFenceEntered = false;
          if (compactProof?.endsWith("AfterWrite")) {
            const originalOperations = PiOperations.makeProjectTeamPiOperations;
            const publicationSpy = vi
              .spyOn(PiOperations, "makeProjectTeamPiOperations")
              .mockImplementation((options) =>
                originalOperations(options).pipe(
                  Effect.map((operations) => ({
                    ...operations,
                    publication: (...args: Parameters<typeof operations.publication>) => {
                      const [captured, terminal, fence] = args;
                      if (captured.operation.operationKind !== "compact" || !fence)
                        return operations.publication(...args);
                      return operations.publication(captured, terminal, {
                        ...fence,
                        check: (authority) => {
                          // Actual physical mutation after the settlement write, before the last caller fence.
                          finalFenceEntered = true;
                          const fs = process.getBuiltinModule("fs");
                          if (selectedSkill)
                            fs.writeFileSync(
                              selectedSkill.packagePath + "/SKILL.md",
                              "Changed at final SQL fence",
                            );
                          else {
                            fs.renameSync(
                              authority.binding.worktree,
                              authority.binding.worktree + "-replaced",
                            );
                            fs.mkdirSync(authority.binding.worktree);
                          }
                          fence.check(authority);
                        },
                      });
                    },
                  })),
                ),
              );
            yield* Effect.addFinalizer(() => Effect.sync(() => publicationSpy.mockRestore()));
          }
          let returnBoundaryCause = "";
          let returnCleanup: string | undefined;
          const authorization = yield* Authorization.ProjectTeamAuthorization;
          const returnAuthorization = Authorization.ProjectTeamAuthorization.of({
            ...authorization,
            discover: (...args) =>
              authorization.discover(...args).pipe(
                Effect.tapCause((cause) =>
                  Effect.sync(() => {
                    returnBoundaryCause = json(cause.reasons) + "\n" + Cause.pretty(cause);
                  }),
                ),
              ),
          });
          const forwardSql = yield* SqlClient.SqlClient;
          const forwardRuntimeCheck = Effect.gen(function* () {
            const atBoundary =
              compactProof === "memoryForwardExtract" ||
              compactProof === "memoryServerExtract" ||
              compactProof === "memoryServerCurrent"
                ? memoryExchanges === 0
                : compactProof === "memoryForwardEmbed" || compactProof === "memoryServerEmbed"
                  ? memoryExchanges === 1
                  : compactProof === "memoryForwardIndex"
                    ? memoryExchanges === 2 && memoryBackendCalls === 0
                    : compactProof === "memoryForwardQueryEmbed" || serverQuery
                      ? memoryExchanges === 2 && memoryBackendCalls === 3
                      : memoryExchanges === 3 && memoryBackendCalls === 3;
            if (!forwardArmed || !atBoundary || (serverProof && !forwardingAtServer)) return;
            expect(Option.isNone(yield* Effect.serviceOption(forwardSql.transactionService))).toBe(
              true,
            );
            forwardChecks++;
            yield* Deferred.succeed(forwardEntered, undefined);
            yield* Deferred.await(forwardRelease);
            if (serverProof) return;
            return yield* new PiManagedRuntimeError({
              code: "denied",
              detail: "Captured original runtime was revoked while waiting",
            });
          });
          const controlledMemoryPorts = ProjectMemoryPorts.of({
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
            readConfiguration: () => Effect.succeed(memoryReady ? queryConfiguration : undefined),
            consumeQuery: (principal, id) => consumeQuery?.(principal, id) ?? Effect.void,
            readQueryCache: (principal) => readQueryCache?.(principal) ?? Effect.succeed(undefined),
          });
          const f = yield* requiredTransferFixture(
            false,
            memoryRoot ||
              compactProof === "memorySharedRoot" ||
              compactProof === "memoryCompanionSharedRoot",
            undefined,
            memoryProof,
            compactProof === "memoryQueryNoGrant"
              ? "read-only"
              : compactProof === "memoryQueryNoAccess" || compactProof === "memoryQuerySharedNone"
                ? "none"
                : sharedQuery && !sharedDenied
                  ? "shared"
                  : "project",
            undefined,
            memoryRoot
              ? {
                  ...subscriptionRuntimeProfile,
                  role: "implementer",
                  model: hardRoot ? model : "gpt-6-luna",
                  maxInputTokens: lunaChild ? 16_384 : 100,
                  maxOutputTokens: lunaChild ? 2048 : 100,
                  memoryChild: {
                    model: lunaChild ? "gpt-6-luna" : model,
                    maximumTokens: childCeiling,
                  },
                }
              : subscriptionMemory
                ? { ...subscriptionRuntimeProfile, role: "implementer", maxInputTokens: 32_768 }
                : selectedSkill
                  ? {
                      ...basicRuntimeProfile,
                      roleSkillIds: [selectedSkill.manifest.id],
                      skillIds: [selectedSkill.manifest.id],
                    }
                  : undefined,
            forwardProof || serverCurrent ? forwardRuntimeCheck : undefined,
          ).pipe(
            Effect.provideService(Authorization.ProjectTeamAuthorization, returnAuthorization),
            Effect.provideService(ProjectMemoryPorts, controlledMemoryPorts),
            Effect.provideService(ProjectWorkContentGuard, queryGuard),
          );
          let memoryRequest: typeof ProjectTeamMemoryProcessIntent.Type | undefined;
          let memoryReceipt: typeof ProjectWorkWriteResult.Type | undefined;
          let memorySourceId: string | undefined;
          let queryRequest: typeof ProjectTeamMemoryQueryIntent.Type | undefined;
          let queryReceipt: typeof ProjectWorkWriteResult.Type | undefined;
          let queryWorkerId: string | undefined;
          const deleteRetainedProject = Effect.fn("memoryLive.deleteRetainedProject")(function* () {
            const paths = yield* f.sql<{
              path: string;
            }>`SELECT workspace_root AS path FROM projection_projects
              WHERE project_id=${projectId} LIMIT 2`;
            const path = paths[0]?.path;
            if (paths.length !== 1 || path === undefined)
              return yield* Effect.die("Original cleanup project path missing");
            const lifecycle = yield* Effect.service(ProjectLifecycle).pipe(
              Effect.provide(ProjectLifecycleLive),
              Effect.provideService(ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
              }),
            );
            return yield* lifecycle.permanentDelete({
              commandId: CommandId.make("live-memory-project-delete"),
              projectId,
              workspaceRoot: path,
              confirmation: "permanent-local-delete",
            });
          });
          const probeForward = (
            effect: Effect.Effect<void, ProjectMemoryServiceError>,
            query: boolean,
          ) =>
            (!forwardProof && !serverCurrent) || query !== (forwardQuery || serverQuery)
              ? effect
              : Effect.gen(function* () {
                  forwardArmed = true;
                  const running = yield* Effect.forkChild(effect);
                  const reached = yield* Effect.raceFirst(
                    Deferred.await(forwardEntered).pipe(Effect.as(true)),
                    Fiber.await(running).pipe(Effect.as(false)),
                  );
                  expect(reached).toBe(true);
                  // The captured bridge is waiting; this separate connection use must finish.
                  expect(
                    yield* f.sql.withTransaction(f.sql`SELECT 1 AS available`).pipe(Effect.orDie),
                  ).toEqual([{ available: 1 }]);
                  if (serverDeny) {
                    const ownerProjectId = serverQuery ? sharedOwnerId : projectId;
                    const state = yield* readCurrentState(f.sql, ownerProjectId).pipe(Effect.orDie);
                    const jobs = yield* f.sql<{ sourceId: string }>`SELECT
                      json_extract(owner_json,'$.selection.sourceRecordId') AS sourceId
                      FROM project_team_memory_job WHERE owner_json IS NOT NULL`.pipe(Effect.orDie);
                    const sourceId = serverQuery
                      ? sharedSelection?.sourceRecordId
                      : jobs[0]?.sourceId;
                    const source = state.foundationRecords?.find(
                      (record) => record.recordId === sourceId,
                    );
                    if (source?.kind !== "memory-source")
                      return yield* Effect.die("Exact forwarding source missing");
                    yield* f.repository
                      .execute(
                        yield* decodeRequiredFoundation({
                          type: "project-work.foundation.commit",
                          commandId: "retract-during-final-runtime-wait",
                          projectId: ownerProjectId,
                          expectedRevision: state.revision,
                          attribution,
                          committedAt: at,
                          records: [
                            {
                              ...source,
                              revision: source.revision + 1,
                              status: "retracted",
                              tombstonedAt: at,
                              sharedWithProjectIds: [],
                              updatedAt: at,
                            },
                          ],
                        }).pipe(Effect.orDie),
                      )
                      .pipe(Effect.orDie);
                  }
                  yield* Deferred.succeed(forwardRelease, undefined);
                  return yield* Fiber.join(running);
                }).pipe(
                  Effect.ensuring(Deferred.succeed(forwardRelease, undefined)),
                  Effect.ensuring(
                    Effect.sync(() => {
                      forwardArmed = false;
                    }),
                  ),
                );
          let runInstance = f.instance;
          if (subscriptionMemory || (memoryRoot && lunaChild)) {
            const deadline = f.snapshot.intent.limits.rootDeadlineAtMs;
            const access = `header.${Buffer.from(
              json({
                exp: Math.ceil(deadline / 1000) + 60,
                "https://api.openai.com/auth": { chatgpt_account_id: "memory-fixture-account" },
              }),
            ).toString("base64url")}.signature`;
            yield* f.fs.writeFileString(
              f.options.agentDirectory + "/auth.json",
              json({
                "openai-codex": {
                  type: "oauth",
                  access,
                  expires: deadline + 60_000,
                  accountId: "memory-fixture-account",
                },
              }),
            );
            runInstance = yield* (yield* makePiManagedRuntimeLive({
              ...f.options,
              subscriptionTest: {
                selection: subscriptionSelection(f),
                credentialSource: { directory: f.options.agentDirectory, format: "pi" },
              },
            }).pipe(
              Effect.provideService(ProjectMemoryPorts, controlledMemoryPorts),
              Effect.provideService(ProjectWorkContentGuard, queryGuard),
            )).forInstance({ instanceId: providerInstanceId, enabled: true, configuration: {} });
          }
          let returnSkillPlan:
            | Effect.Success<ReturnType<typeof selectedRuntimeFixture>>["plan"]
            | undefined;
          if (selectedSkill) {
            const materialization = yield* Materialization.SkillMaterializationService;
            const desiredRevision = SkillCatalogRevision.make(1);
            const materialized = yield* materialization.materialize({
              sessionId: catalogueRequest(f.binding.worktree).runtime.sessionId,
              providerInstanceId,
              desiredRevision,
              packages: [
                { key: selectedSkill.manifest.key, sourcePath: selectedSkill.packagePath },
              ],
            });
            returnSkillPlan = {
              providerInstanceId,
              desiredRevision,
              applicationMode: "new_session_required",
              skillKeys: [selectedSkill.manifest.key],
              payload: {
                kind: "pi-managed-skills",
                root: materialized.root,
                skills: [
                  {
                    key: selectedSkill.manifest.key,
                    path: materialized.skillPaths.get(selectedSkill.manifest.key)! + "/SKILL.md",
                  },
                ],
              },
            };
            const cache = yield* f.fs.makeTempDirectoryScoped();
            yield* f.fs.chmod(cache, 0o700);
            runInstance = yield* (yield* makePiManagedRuntimeLive({
              ...f.options,
              allocateSkillStage: makePiSkillStageLifetime(cache),
            })).forInstance({
              instanceId: providerInstanceId,
              enabled: true,
              configuration: {},
            });
          }
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
            verifySettlement: () =>
              Effect.gen(function* () {
                const owners = yield* f.sql<{
                  status: string;
                }>`SELECT process.status FROM project_team_pi_process process
                JOIN project_team_pi_operation operation ON operation.operation_id=process.operation_id
                WHERE operation.binding_id=${f.binding.recordId} AND operation.generation=${f.binding.generation}`;
                if (owners.length !== 3 || owners.some((owner) => owner.status !== "drained"))
                  return yield* new ProjectTeamDispatchJournalError({
                    reason: "Controlled owners are not drained",
                  });
                const requests = yield* f.sql`SELECT 1 FROM project_team_model_request
                WHERE run_id=${f.binding.recordId} AND capacity_state<>'released' LIMIT 1`;
                if (requests.length)
                  return yield* new ProjectTeamDispatchJournalError({
                    reason: "Controlled accounting is not drained",
                  });
              }).pipe(
                Effect.catchTag("SqlError", () =>
                  Effect.fail(
                    new ProjectTeamDispatchJournalError({
                      reason: "Controlled settlement accounting could not be read",
                    }),
                  ),
                ),
              ),
          });
          const readRecordedUsage = Effect.fn("controlledUsage.read")(function* () {
            const allocationsBefore = f.allocations;
            const callsBefore = { exchanges: memoryExchanges, backend: memoryBackendCalls };
            const result = yield* f.sql
              .withTransaction(
                readProjectTeamBindingAccountingInTransaction(f.sql, String(projectId), [
                  {
                    recordId: f.binding.recordId,
                    taskId: f.binding.taskId,
                    attemptId: f.binding.attemptId,
                    generation: f.binding.generation,
                  },
                ]),
              )
              .pipe(
                Effect.provideService(ServerEnvironmentIdentity, {
                  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
                }),
              );
            expect(f.allocations).toBe(allocationsBefore);
            expect({ exchanges: memoryExchanges, backend: memoryBackendCalls }).toEqual(
              callsBefore,
            );
            return result;
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
            | ProjectWorkProjection
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
                      let settleSubscriptionPi: Effect.Effect<void, Cause.UnknownError> | undefined;
                      const failedUsage =
                        accountingProof && input.operation.operationId === failedUsageOperationId;
                      if (input.operation.operationKind !== "initialize" && !memoryRoot) {
                        for (const requestId of subscriptionMemory ? [1, 2] : [1]) {
                          const fields = {
                            workerId: input.identity.workerId,
                            generation: input.identity.generation,
                            operationId: input.operation.operationId,
                            requestId,
                            routeId: input.broker.routeId,
                            provider: input.broker.provider,
                            model: input.broker.model,
                            maxInputTokens: subscriptionMemory
                              ? 29_832
                              : input.broker.maxInputTokens,
                            maxOutputTokens: input.broker.maxOutputTokens,
                            callCount: 1 as const,
                            ...(subscriptionMemory
                              ? {
                                  accountingMode: "openai-subscription-monitored" as const,
                                  unknownMaximumTokens: 64_000 as const,
                                }
                              : {}),
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
                          const usage = subscriptionMemory
                            ? {
                                prompt_tokens: 29_832,
                                completion_tokens: 2_048,
                                total_tokens: 31_880,
                              }
                            : { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
                          const unknownPi = failedUsage || (piUnknown && requestId === 2);
                          const settlePi = Effect.gen(function* () {
                            const settled = yield* Effect.tryPromise(() =>
                              input.broker.settleRequest({
                                ...fields,
                                reservationId: reserved.reservationId,
                                transportDrained: true,
                                outcome: unknownPi ? "unknown" : "reported",
                                chargedInputTokens: unknownPi
                                  ? fields.maxInputTokens
                                  : usage.prompt_tokens,
                                chargedOutputTokens: unknownPi
                                  ? subscriptionMemory
                                    ? 64_000
                                    : fields.maxOutputTokens
                                  : usage.completion_tokens,
                                ...(unknownPi
                                  ? {}
                                  : { reportedModel: input.broker.model, reportedUsage: usage }),
                              }),
                            );
                            if (!unknownPi)
                              accountingReceipts.push({
                                requestId,
                                reservationId: reserved.reservationId,
                                accountingReceiptId: settled.accountingReceiptId,
                                routeId: fields.routeId,
                                provider: fields.provider,
                                model: fields.model,
                                reportedModel: fields.model,
                                usage,
                              });
                          });
                          if (subscriptionMemory && requestId === 2)
                            settleSubscriptionPi = settlePi;
                          else yield* settlePi;
                        }
                      }
                      if (
                        memoryProof &&
                        input.operation.operationKind === "prompt" &&
                        !failedUsage
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
                        const issueQuery = Effect.fn("controlledQuery.issue")(function* () {
                          if (sharedQuery && sharedSelection === undefined) {
                            yield* f.sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
                              VALUES (${sharedOwnerId},'Shared owner','/fixture/shared-query-owner','[]',${at},${at})`;
                            const ownerTaskId = ProjectWorkTaskId.make("shared-query-owner-task");
                            yield* f.repository.execute({
                              type: "project-work.task.create",
                              projectId: sharedOwnerId,
                              taskId: ownerTaskId,
                              commandId: CommandId.make("shared-owner-task-create"),
                              title: "Owner source",
                              createdAt: at,
                            });
                            const ownerAttribution = {
                              actor: { kind: "human" as const, id: "shared-owner-human" },
                              source: { kind: "web" as const, id: "shared-owner-web" },
                              recordedAt: at,
                            };
                            const ownerComment = yield* decodeMemorySourceComment({
                              commentId: "shared-owner-comment",
                              projectId: sharedOwnerId,
                              taskId: ownerTaskId,
                              body: "The approved parser retains exact provenance.",
                              revision: 0,
                              createdAt: at,
                              attribution: ownerAttribution,
                            });
                            yield* f.repository.execute({
                              type: "project-work.comment.add",
                              commandId: CommandId.make("shared-owner-comment-add"),
                              projectId: sharedOwnerId,
                              comment: ownerComment,
                              addedAt: at,
                              attribution: ownerAttribution,
                            });
                            // Retained owner facts use controlled extraction only. Query embedding,
                            // accounting and companion execution below use their production services.
                            sharedMemory = makeProjectMemoryService({
                              sql: f.sql,
                              repository: f.repository,
                              authorization,
                              contentGuard: queryGuard,
                              environmentId: f.binding.environmentId,
                              models: {
                                extract: () =>
                                  Effect.succeed([
                                    {
                                      key: "shared-parser",
                                      body: ownerComment.body,
                                      quote: "exact provenance",
                                    },
                                  ]),
                                embed: () =>
                                  Effect.die("Shared fixture must not run an embedding model"),
                              },
                            });
                            const source = yield* sharedMemory.captureRetained(sharedOwnerId, {
                              kind: "comment",
                              retainedId: ownerComment.commentId,
                            });
                            const ownerState = yield* readCurrentState(f.sql, sharedOwnerId);
                            const work = ownerState.foundationRecords?.find(
                              (r) => r.kind === "effect" && r.targetId === source.recordId,
                            );
                            if (work?.kind !== "effect")
                              return yield* Effect.die("Shared owner work missing");
                            const claim = yield* sharedMemory.claim(sharedOwnerId, work.effectId);
                            if (claim === undefined)
                              return yield* Effect.die("Shared owner claim missing");
                            yield* sharedMemory.extract(sharedOwnerId, work.effectId, claim);
                            sharedObservation = (yield* sharedMemory.readWork(
                              sharedOwnerId,
                              work.effectId,
                            )).observations[0];
                            const beforeShares = yield* readCurrentState(f.sql, sharedOwnerId);
                            yield* gateway
                              .write(
                                yield* decodeSharedQueryShares({
                                  type: "project-team.memory.shares.replace",
                                  projectId: sharedOwnerId,
                                  commandId: "human-share-query-source",
                                  expectedRevision: beforeShares.revision,
                                  ...projectMemorySourceSelection(source),
                                  sharedWithProjectIds: [projectId],
                                }),
                                ownerAttribution.actor,
                                ownerAttribution.source,
                              )
                              .pipe(
                                Effect.provideService(ProjectWorkVerificationRequest, {
                                  assertCurrent: () => Effect.void,
                                }),
                              );
                            const sharedSource = (yield* readCurrentState(
                              f.sql,
                              sharedOwnerId,
                            )).foundationRecords?.find((r) => r.recordId === source.recordId);
                            if (
                              sharedSource?.kind !== "memory-source" ||
                              sharedObservation === undefined
                            )
                              return yield* Effect.die("Shared source missing");
                            sharedSelection = projectMemorySourceSelection(sharedSource);
                            yield* f.sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,changed_at)
                              VALUES (${sharedOwnerId},'archived','/fixture/shared-query-owner',${at})`;
                            if (!sharedDenied) {
                              const discovered = yield* gateway
                                .read(
                                  {
                                    operation: "memory-shared-sources",
                                    projectId,
                                    taskId: f.binding.taskId,
                                    limit: 32,
                                  },
                                  principal,
                                )
                                .pipe(Effect.flatMap(decodeSharedQuerySources));
                              expect(discovered.items).toEqual([
                                { ownerProjectId: sharedOwnerId, selection: sharedSelection },
                              ]);
                            }
                          }
                          const current = yield* readCurrentState(f.sql, projectId);
                          const task = current.tasks.find(
                            (entry) => entry.taskId === f.binding.taskId,
                          );
                          if (task === undefined)
                            return yield* Effect.die("Current query task missing");
                          const query = yield* decodeMemoryQueryRequest({
                            type: "project-team.memory.query",
                            commandId: "live-memory-query",
                            projectId,
                            taskId: task.taskId,
                            expectedRevision: current.revision,
                            expectedTaskRevision: task.revision,
                            specRevision: task.specRevision,
                            planRevision: f.binding.planRevision,
                            query: queryText,
                            ...(sharedSelection === undefined
                              ? {}
                              : { sharedSource: sharedSelection }),
                          });
                          if (compactProof === "memoryQueryGuards") {
                            const prior = yield* readCurrentState(f.sql, projectId);
                            const charges = yield* f.sql`SELECT * FROM project_team_model_request`;
                            let call = 10;
                            const reject = Effect.fn("controlledQuery.rejectAdmission")(function* (
                              request: typeof ProjectTeamMemoryQueryIntent.Type,
                            ) {
                              const toolInput = { arguments: { intentJSON: json(request) } };
                              const denied = yield* Effect.tryPromise({
                                try: () =>
                                  input.executeBridgeTool(
                                    {
                                      type: "tool-call",
                                      callId: call++,
                                      nativeCallId: "denied-query-" + request.commandId,
                                      lifecycleId: 1,
                                      toolName: "project_work_write",
                                      execution: "bridge",
                                      input: {
                                        transferId: "denied-query-" + request.commandId,
                                        totalBytes: Buffer.byteLength(json(toolInput)),
                                      },
                                    },
                                    toolInput,
                                    signal,
                                  ),
                                catch: controlledCallbackError,
                              }).pipe(Effect.result);
                              expect(denied._tag, request.commandId).toBe("Failure");
                              expect(yield* readCurrentState(f.sql, projectId)).toEqual(prior);
                              expect(yield* f.sql`SELECT * FROM project_team_memory_query`).toEqual(
                                [],
                              );
                              expect(
                                yield* f.sql`SELECT * FROM project_team_model_request`,
                              ).toEqual(charges);
                              expect(
                                yield* f.sql`SELECT * FROM project_work_command_receipts WHERE project_id=${projectId}
                                AND command_id=${request.commandId}`,
                              ).toEqual([]);
                              expect(memoryExchanges).toBe(0);
                              expect(memoryBackendCalls).toBe(0);
                            });
                            memoryReady = true;
                            for (const [name, changed] of [
                              ["aggregate", { expectedRevision: query.expectedRevision + 1 }],
                              ["task", { expectedTaskRevision: query.expectedTaskRevision + 1 }],
                              ["spec", { specRevision: query.specRevision + 1 }],
                              ["plan", { planRevision: query.planRevision + 1 }],
                              ["foreign-task", { taskId: "foreign-query-task" }],
                              ["foreign-project", { projectId: "foreign-query-project" }],
                            ] as const) {
                              yield* reject(
                                yield* decodeMemoryQueryRequest({
                                  ...query,
                                  ...changed,
                                  commandId: "denied-query-" + name,
                                }),
                              );
                            }
                            memoryReady = false;
                            yield* reject(
                              yield* decodeMemoryQueryRequest({
                                ...query,
                                commandId: "denied-query-disabled",
                              }),
                            );
                            memoryReady = true;
                            const noOwner = yield* decodeMemoryQueryRequest({
                              ...query,
                              commandId: "denied-query-ownerless",
                            });
                            expect(
                              (yield* gateway
                                .write(
                                  noOwner,
                                  principal.actor,
                                  { kind: "mcp", id: input.identity.workerId },
                                  principal,
                                )
                                .pipe(Effect.result))._tag,
                            ).toBe("Failure");
                            expect(yield* readCurrentState(f.sql, projectId)).toEqual(prior);
                            expect(yield* f.sql`SELECT * FROM project_team_memory_query`).toEqual(
                              [],
                            );
                            expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual(
                              charges,
                            );
                          }
                          memoryReady = true;
                          const arguments_ = { intentJSON: json(query) };
                          const toolInput = { arguments: arguments_ };
                          const queryResult = yield* Effect.tryPromise({
                            try: () =>
                              input.executeBridgeTool(
                                {
                                  type: "tool-call",
                                  callId: 2,
                                  nativeCallId: "live-memory-query",
                                  lifecycleId: 1,
                                  toolName: "project_work_write",
                                  execution: "bridge",
                                  input: {
                                    transferId: "live-memory-query-input",
                                    totalBytes: Buffer.byteLength(json(toolInput)),
                                  },
                                },
                                toolInput,
                                signal,
                              ),
                            catch: controlledCallbackError,
                          }).pipe(Effect.result);
                          if (forwardQuery) {
                            expect(queryResult._tag).toBe("Success");
                            expect(forwardChecks).toBe(1);
                            expect(memoryPipelineError).toBeDefined();
                            expect(memoryExchanges).toBe(
                              compactProof === "memoryForwardQueryEmbed" || serverQuery ? 2 : 3,
                            );
                            expect(memoryBackendCalls).toBe(3);
                            forwardDeniedObserved = true;
                            return;
                          }
                          if (!queryDenied) {
                            expect(
                              queryResult._tag === "Failure"
                                ? {
                                    bridgeFailure: queryResult.failure,
                                    processingCause: memoryPipelineFailure,
                                  }
                                : undefined,
                            ).toBeUndefined();
                            expect({
                              processingFailure: memoryPipelineError,
                              processingCause: memoryPipelineFailure,
                            }).toEqual({
                              processingFailure:
                                queryRecovery || queryNoForward || sharedDeliveryDenied
                                  ? memoryPipelineError
                                  : undefined,
                              processingCause:
                                queryRecovery || queryNoForward || sharedDeliveryDenied
                                  ? memoryPipelineFailure
                                  : "",
                            });
                          }
                          if (queryDenied) {
                            expect(queryResult._tag).toBe("Failure");
                            expect(yield* f.sql`SELECT * FROM project_team_memory_query`).toEqual(
                              [],
                            );
                            expect((yield* readCurrentState(f.sql, projectId)).revision).toBe(
                              current.revision,
                            );
                            expect(memoryExchanges).toBe(0);
                            expect(memoryBackendCalls).toBe(0);
                            return;
                          }
                          expect(queryResult).toMatchObject({ _tag: "Success" });
                          if (queryResult._tag !== "Success" || queryResult.success.kind !== "text")
                            return yield* Effect.die("Semantic query returned no retained receipt");
                          const receipt = yield* decodeReportReceipt(queryResult.success.text);
                          queryRequest = query;
                          queryReceipt = receipt;
                          queryWorkerId = input.identity.workerId;
                          expect(receipt.receipt).toMatchObject({
                            commandId: query.commandId,
                            status: "accepted",
                          });
                          const admitted = yield* readCurrentState(f.sql, projectId);
                          expect(
                            admitted.foundationRecords?.some(
                              (record) =>
                                record.kind === "effect" &&
                                record.effectKind === "memory-query" &&
                                record.taskId === task.taskId,
                            ),
                          ).toBe(true);
                          if (queryCache)
                            expect({
                              error: memoryPipelineError,
                              failure: memoryPipelineFailure,
                            }).toEqual({ error: undefined, failure: "" });
                          expect(memoryExchanges).toBe(queryNoForward ? 2 : queryForward ? 3 : 0);
                          expect(memoryBackendCalls).toBe(
                            queryNoForward
                              ? 3
                              : queryForward &&
                                  !sharedBeforeSearchDenied &&
                                  compactProof !== "memoryQueryModelUnknown" &&
                                  !joinedRecovery &&
                                  !startFailure
                                ? 4
                                : queryRecovery || sharedBeforeSearchDenied
                                  ? 3
                                  : 0,
                          );
                          const ledger = yield* auditProjectMemoryOperationLedger(f.sql, {
                            environmentId: f.binding.environmentId,
                            projectId,
                            bindingId: f.binding.recordId,
                            generation: f.binding.generation,
                            operationId: input.operation.operationId,
                          });
                          if (!queryNoForward) expect(ledger.settled).toBe(queryCache);
                          if (queryAdmissionOnly) memoryReady = false;
                        });
                        if (queryAdmissionOnly) yield* issueQuery();
                        if (!queryAdmissionOnly) {
                          const comment = yield* decodeMemorySourceComment({
                            commentId: "live-memory-comment",
                            projectId,
                            taskId: f.binding.taskId,
                            body:
                              "The approved operation retains exact parser provenance." +
                              (compactProof === "memorySecret" ? " " + lateSecret : ""),
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
                          const contentGuard = queryForward
                            ? queryGuard
                            : yield* Effect.gen(function* () {
                                return yield* ProjectWorkContentGuard;
                              }).pipe(Effect.provide(ProjectWorkContentGuardLive));
                          const memory = makeProjectMemoryService({
                            sql: f.sql,
                            repository: f.repository,
                            authorization,
                            contentGuard,
                            environmentId: f.binding.environmentId,
                          });
                          const commentSource = yield* memory.capture(principal, {
                            kind: "comment",
                            retainedId: comment.commentId,
                          });
                          let cleanupEffectId: string | undefined;
                          if (cleanupProof) {
                            const human = { kind: "human" as const, id: "live-memory-human" };
                            const humanSource = { kind: "web" as const, id: "live-memory-browser" };
                            const decision = yield* decodeMemorySourceDecision({
                              decisionId: "live-memory-decision",
                              projectId,
                              title: "Approved parser constraint",
                              body: "The approved parser retains exact parser provenance.",
                              state: "proposed",
                              revision: 0,
                              createdAt: at,
                              updatedAt: at,
                            });
                            yield* gateway.write(
                              {
                                type: "project-work.decision.propose",
                                commandId: CommandId.make("live-memory-decision-propose"),
                                projectId,
                                decision,
                                proposedAt: at,
                              },
                              human,
                              humanSource,
                              { actor: human },
                            );
                            yield* gateway.write(
                              {
                                type: "project-work.decision.accept",
                                commandId: CommandId.make("live-memory-decision-accept"),
                                projectId,
                                decisionId: decision.decisionId,
                                acceptedAt: at,
                              },
                              human,
                              humanSource,
                              { actor: human },
                            );
                            const original = yield* memory.capture(principal, {
                              kind: "decision",
                              retainedId: decision.decisionId,
                            });
                            if (humanRetraction) {
                              const before = yield* readCurrentState(f.sql, projectId);
                              yield* gateway
                                .write(
                                  {
                                    type: "project-team.memory.retract",
                                    commandId: CommandId.make("live-memory-human-retract"),
                                    projectId,
                                    expectedRevision: before.revision,
                                    sourceRecordId: original.recordId,
                                    expectedSourceRecordRevision: original.revision,
                                    sourceRevision: original.sourceRevision,
                                    sourceGeneration: original.generation,
                                    contentHash: original.contentHash,
                                  },
                                  human,
                                  humanSource,
                                  { actor: human },
                                )
                                .pipe(
                                  Effect.provideService(
                                    ProjectWorkVerificationRequest,
                                    ProjectWorkVerificationRequest.of({
                                      assertCurrent: (caller, id, permission) =>
                                        caller.actor.kind === "human" &&
                                        caller.managed === undefined &&
                                        id === projectId &&
                                        permission === "write"
                                          ? Effect.void
                                          : Effect.fail(
                                              new ProjectWorkVerificationRequestError({
                                                reason: "denied",
                                              }),
                                            ),
                                    }),
                                  ),
                                );
                              const retracted = yield* readCurrentState(f.sql, projectId);
                              expect(retracted.decisions).toEqual(before.decisions);
                              expect(
                                retracted.foundationRecords?.find(
                                  (entry) => entry.recordId === original.recordId,
                                ),
                              ).toMatchObject({
                                status: "retracted",
                                sharedWithProjectIds: [],
                              });
                              const deletion = retracted.foundationRecords?.find(
                                (entry) =>
                                  entry.kind === "effect" &&
                                  entry.effectKind === "memory-delete" &&
                                  entry.targetId === original.recordId,
                              );
                              if (deletion?.kind !== "effect")
                                return yield* Effect.die("Human retraction cleanup missing");
                              cleanupEffectId = deletion.effectId;
                              const pendingDeletion = yield* deleteRetainedProject().pipe(
                                Effect.result,
                              );
                              expect(pendingDeletion._tag).toBe("Failure");
                              if (pendingDeletion._tag === "Failure")
                                expect(pendingDeletion.failure).toMatchObject({
                                  _tag: "ProjectLifecycleError",
                                  reason: "memory-cleanup-required",
                                });
                              expect((yield* readCurrentState(f.sql, projectId)).decisions).toEqual(
                                retracted.decisions,
                              );
                            } else {
                              const replacement = yield* decodeMemorySourceDecision({
                                ...decision,
                                decisionId: "live-memory-decision-replacement",
                                body: "The approved parser now rejects obsolete input.",
                              });
                              yield* gateway.write(
                                {
                                  type: "project-work.decision.supersede",
                                  commandId: CommandId.make("live-memory-decision-supersede"),
                                  projectId,
                                  decisionId: decision.decisionId,
                                  replacement,
                                  supersededAt: at,
                                  attribution: {
                                    actor: human,
                                    source: humanSource,
                                    recordedAt: at,
                                  },
                                },
                                human,
                                humanSource,
                                { actor: human },
                              );
                              yield* gateway.write(
                                {
                                  type: "project-work.decision.accept",
                                  commandId: CommandId.make("live-memory-replacement-accept"),
                                  projectId,
                                  decisionId: replacement.decisionId,
                                  acceptedAt: at,
                                },
                                human,
                                humanSource,
                                { actor: human },
                              );
                              const corrected = yield* memory.capture(principal, {
                                kind: "decision",
                                retainedId: replacement.decisionId,
                              });
                              expect(corrected).toMatchObject({
                                sourceId: original.sourceId,
                                supersedes: original.recordId,
                                status: "current",
                              });
                              const correctedState = yield* readCurrentState(f.sql, projectId);
                              const oldSource = correctedState.foundationRecords?.find(
                                (entry) => entry.recordId === original.recordId,
                              );
                              expect(oldSource).toMatchObject({
                                kind: "memory-source",
                                status: "superseded",
                              });
                              const deletion = correctedState.foundationRecords?.find(
                                (entry) =>
                                  entry.kind === "effect" &&
                                  entry.effectKind === "memory-delete" &&
                                  entry.targetId === original.recordId,
                              );
                              if (deletion?.kind !== "effect")
                                return yield* Effect.die("Correction retained no cleanup intent");
                              cleanupEffectId = deletion.effectId;
                              expect(
                                yield* f.sql`SELECT status,owner_json,receipt_json,
                            json_extract(input_json,'$.effect.effectKind') AS kind,
                            json_extract(input_json,'$.source.recordId') AS sourceId
                            FROM project_team_memory_job WHERE effect_id=${cleanupEffectId}`,
                              ).toEqual([
                                {
                                  status: "pending",
                                  owner_json: null,
                                  receipt_json: null,
                                  kind: "memory-delete",
                                  sourceId: original.recordId,
                                },
                              ]);
                              expect(memoryExchanges).toBe(0);
                              expect(memoryBackendCalls).toBe(0);
                            }
                          }
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
                          const selection =
                            cleanupEffectId === undefined
                              ? page.items[0]?.selection
                              : page.items.find(
                                  (entry) => entry.selection.effectId === cleanupEffectId,
                                )?.selection;
                          if (cleanupProof) {
                            expect(selection).toMatchObject({
                              kind: "decision",
                              retainedId: "live-memory-decision",
                              effectId: cleanupEffectId,
                            });
                            if (!humanRetraction)
                              expect(
                                page.items.some(
                                  (entry) =>
                                    entry.selection.retainedId ===
                                    "live-memory-decision-replacement",
                                ),
                              ).toBe(true);
                            expect(
                              yield* f.sql`SELECT reservation_id FROM project_team_model_request WHERE request_lane='memory'`,
                            ).toEqual([]);
                          }
                          const state = yield* readCurrentState(f.sql, projectId);
                          const task = state.tasks.find(
                            (entry) => entry.taskId === f.binding.taskId,
                          );
                          if (selection === undefined || task === undefined)
                            return yield* Effect.die("Memory selector missing");
                          let expectedCleanupSelection = selection;
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
                          if (humanRetraction) {
                            const receipts = yield* f.sql<{
                              fingerprint: string;
                            }>`SELECT payload_fingerprint AS fingerprint
                              FROM project_work_command_receipts WHERE project_id=${projectId}
                              AND command_id='live-memory-human-retract'`;
                            const fingerprint = receipts[0]?.fingerprint;
                            if (fingerprint === undefined)
                              return yield* Effect.die("Human retraction receipt missing");
                            yield* f.sql`UPDATE project_work_command_receipts SET payload_fingerprint=${"project-team-intent:" + "0".repeat(64)}
                              WHERE project_id=${projectId} AND command_id='live-memory-human-retract'`;
                            expect(
                              (yield* Effect.tryPromise({
                                try: () => input.executeBridgeTool(call, toolInput, signal),
                                catch: controlledCallbackError,
                              }).pipe(Effect.result))._tag,
                            ).toBe("Failure");
                            expect(
                              yield* f.sql`SELECT owner_json,receipt_json FROM project_team_memory_job
                              WHERE effect_id=${selection.effectId}`,
                            ).toEqual([{ owner_json: null, receipt_json: null }]);
                            expect({
                              exchanges: memoryExchanges,
                              backend: memoryBackendCalls,
                            }).toEqual({ exchanges: 0, backend: 0 });
                            yield* f.sql`UPDATE project_work_command_receipts SET payload_fingerprint=${fingerprint}
                              WHERE project_id=${projectId} AND command_id='live-memory-human-retract'`;
                          }
                          if (compactProof === "memoryCleanupGuards") {
                            const originalEvents = yield* f.sql<{
                              payload: string;
                            }>`SELECT payload_json AS payload
                            FROM project_work_events WHERE project_id=${projectId}
                            AND command_id='live-memory-decision-supersede'`;
                            expect(originalEvents).toHaveLength(1);
                            const originalEvent = originalEvents[0]?.payload;
                            if (originalEvent === undefined)
                              return yield* Effect.die("Original replacement event missing");
                            const originalReceipt =
                              yield* f.sql`SELECT * FROM project_work_command_receipts
                            WHERE project_id=${projectId} AND command_id='live-memory-decision-supersede'`;
                            yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,
                            '$.attribution.actor.id','forged-memory-human',
                            '$.replacement.attribution.actor.id','forged-memory-human')
                            WHERE project_id=${projectId} AND command_id='live-memory-decision-supersede'`;
                            expect(
                              yield* f.sql`SELECT json_extract(payload_json,'$.attribution.actor.id') AS actor,
                            json_extract(payload_json,'$.replacement.attribution.actor.id') AS nested
                            FROM project_work_events WHERE project_id=${projectId}
                            AND command_id='live-memory-decision-supersede'`,
                            ).toEqual([
                              { actor: "forged-memory-human", nested: "forged-memory-human" },
                            ]);
                            expect(
                              yield* f.sql`SELECT * FROM project_work_command_receipts
                            WHERE project_id=${projectId} AND command_id='live-memory-decision-supersede'`,
                            ).toEqual(originalReceipt);
                            const forgedLineage = yield* Effect.tryPromise({
                              try: () => input.executeBridgeTool(call, toolInput, signal),
                              catch: controlledCallbackError,
                            }).pipe(Effect.result);
                            expect(forgedLineage._tag).toBe("Failure");
                            expect(
                              yield* f.sql`SELECT owner_json,receipt_json FROM project_team_memory_job
                            WHERE effect_id=${selection.effectId}`,
                            ).toEqual([{ owner_json: null, receipt_json: null }]);
                            expect(memoryBackendCalls).toBe(0);
                            yield* f.sql`UPDATE project_work_events SET payload_json=${originalEvent}
                            WHERE project_id=${projectId} AND command_id='live-memory-decision-supersede'`;
                            const jobs = yield* f.sql<{
                              payload: string;
                            }>`SELECT input_json AS payload
                            FROM project_team_memory_job WHERE effect_id=${selection.effectId}`;
                            const originalJob = jobs[0]?.payload;
                            if (originalJob === undefined)
                              return yield* Effect.die("Original cleanup job missing");
                            const changedJob =
                              yield* f.sql`UPDATE project_team_memory_job SET input_json=json_set(input_json,
                            '$.effect.effectKind','memory-index') WHERE effect_id=${selection.effectId}`.pipe(
                                Effect.result,
                              );
                            expect(changedJob._tag).toBe("Failure");
                            expect(
                              yield* f.sql`SELECT input_json AS payload FROM project_team_memory_job
                            WHERE effect_id=${selection.effectId}`,
                            ).toEqual([{ payload: originalJob }]);
                            expect(
                              yield* f.sql`SELECT owner_json,receipt_json FROM project_team_memory_job
                            WHERE effect_id=${selection.effectId}`,
                            ).toEqual([{ owner_json: null, receipt_json: null }]);
                            expect(memoryExchanges).toBe(0);
                            expect(memoryBackendCalls).toBe(0);
                            expect((yield* readCurrentState(f.sql, projectId)).revision).toBe(
                              state.revision,
                            );
                          }
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
                          if (
                            pipelineProof ||
                            liquidDenied ||
                            sourceFailure ||
                            compactProof === "memorySecret" ||
                            compactProof === "memoryEmbeddingSecret" ||
                            queryForward ||
                            cleanupProof
                          ) {
                            const drained = memoryDrains;
                            const indexed = new Set<string>();
                            let configuration: ProjectMemoryProcessingConfiguration = {
                              version: 1,
                              extraction: {
                                endpoint: liquidProof
                                  ? "https://openrouter.ai/api/v1/chat/completions"
                                  : "https://api.commandcode.ai/provider/v1/chat/completions",
                                routeId: liquidProof ? "controlled-liquid" : "controlled-ling",
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
                            let consumerOptions: ProjectMemoryProcessingConsumerOptions = {
                              environmentId: "environment",
                              maximumConcurrentCalls: 2,
                              maximumConcurrentModelCalls: 2,
                              readConfiguration: Effect.sync(() =>
                                queryForward ? queryConfiguration : configuration,
                              ),
                              assertAdmission: Effect.void,
                              readCredential: (reference) =>
                                Effect.gen(function* () {
                                  if (queryNoForward && activeQuery) {
                                    const queries = yield* f.sql<{
                                      id: string;
                                    }>`SELECT query_id AS id FROM project_team_memory_query WHERE status='embedding' AND embedding_result_json IS NULL AND result_json IS NULL`;
                                    if (!queries[0] || !consumer.consumeQuery)
                                      return yield* Effect.die("Unreserved winner missing");
                                    const wakes = recoveryWakes.length;
                                    const duplicate = yield* consumer
                                      .consumeQuery(principal, queries[0].id)
                                      .pipe(Effect.result, Effect.forkChild);
                                    expect((yield* Fiber.join(duplicate))._tag).toBe("Failure");
                                    expect(recoveryWakes.length).toBe(wakes);
                                    expect(
                                      yield* f.sql`SELECT status,result_json FROM project_team_memory_query`,
                                    ).toEqual([{ status: "embedding", result_json: null }]);
                                    expect(
                                      yield* f.sql`SELECT reservation_id FROM project_team_model_request WHERE json_extract(reservation_json,'$.effectId')=${queries[0].id}`,
                                    ).toEqual([]);
                                  }
                                  return activeQuery && querySecret
                                    ? queryText
                                    : compactProof === "memorySecret" ||
                                        (compactProof === "memoryEmbeddingSecret" &&
                                          reference === "controlled-embedding")
                                      ? lateSecret
                                      : "controlled-memory-credential";
                                }).pipe(Effect.orDie),
                              observeCompanionCleanup: (id) =>
                                Effect.gen(function* () {
                                  recoveryWakes.push(id);
                                  if (queryNoForward && activeQuery)
                                    yield* Deferred.succeed(queryCleanupQueued, id);
                                }),
                              releaseModelTransportObservation: (id) =>
                                Effect.gen(function* () {
                                  const rows = yield* f.sql<{
                                    status: string;
                                    capacity: string;
                                    settlement: string;
                                  }>`SELECT status,capacity_state AS capacity,settlement_json AS settlement
                                    FROM project_team_model_request WHERE reservation_id=${id}`;
                                  expect(rows).toHaveLength(1);
                                  expect(rows[0]?.status).not.toBe("held");
                                  expect(rows[0]?.capacity).toBe("released");
                                  expect(
                                    decodeRequiredJson(rows[0]?.settlement ?? "null"),
                                  ).toMatchObject({
                                    transportDrained: true,
                                  });
                                  releasedModelObservations.push(id);
                                  drained.delete(id);
                                }).pipe(Effect.orDie),
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
                                  if (activeQuery) {
                                    expect(exchange.phase).toBe("embed");
                                    expect(exchange.input).toEqual([queryText]);
                                    const queries = yield* f.sql<{
                                      embedding: string;
                                      status: string;
                                    }>`SELECT embedding_json AS embedding,status FROM project_team_memory_query`;
                                    expect(queries).toHaveLength(1);
                                    expect(queries[0]?.status).toBe("embedding");
                                    expect(
                                      decodeRequiredJson(queries[0]?.embedding ?? "null"),
                                    ).toMatchObject({ requestId: 1, queryId: expect.any(String) });
                                    expect(
                                      yield* f.sql`SELECT request_lane,operation_id,status FROM project_team_model_request WHERE reservation_id=${id}`,
                                    ).toEqual([
                                      {
                                        request_lane: "memory",
                                        operation_id: input.operation.operationId,
                                        status: "held",
                                      },
                                    ]);
                                    memoryExchanges++;
                                    if (compactProof === "memoryQueryInterruptedRecovery") {
                                      yield* Deferred.succeed(queryInterrupted, undefined);
                                      return yield* Effect.never;
                                    }
                                    if (
                                      compactProof === "memoryQueryModelUnknown" ||
                                      joinedRecovery
                                    )
                                      return yield* new ProjectMemoryServiceError({
                                        reason: "Controlled query exchange is unknown",
                                      });
                                    if (sharedBeforeSearchDenied) {
                                      yield* f.sql`UPDATE project_lifecycle SET state='active' WHERE project_id=${sharedOwnerId}`;
                                      const ownerState = yield* readCurrentState(
                                        f.sql,
                                        sharedOwnerId,
                                      );
                                      const source = ownerState.foundationRecords?.find(
                                        (r) =>
                                          r.kind === "memory-source" &&
                                          r.recordId === sharedSelection?.sourceRecordId,
                                      );
                                      if (source?.kind !== "memory-source")
                                        return yield* Effect.die("Missing delayed source");
                                      yield* gateway
                                        .write(
                                          yield* decodeSharedQueryShares({
                                            type: "project-team.memory.shares.replace",
                                            projectId: sharedOwnerId,
                                            commandId: "revoke-inflight-query",
                                            expectedRevision: ownerState.revision,
                                            ...projectMemorySourceSelection(source),
                                            sharedWithProjectIds: [],
                                          }),
                                          { kind: "human", id: "shared-owner-human" },
                                          { kind: "web", id: "shared-owner-web" },
                                        )
                                        .pipe(
                                          Effect.provideService(ProjectWorkVerificationRequest, {
                                            assertCurrent: () => Effect.void,
                                          }),
                                        );
                                    }
                                    if (compactProof === "memoryQueryDrainCapacity") {
                                      // Other retained observations leave exactly one production drain slot.
                                      for (let i = 0; drained.size < 255; i++)
                                        drained.add(`retained-drain-${i}`);
                                    }
                                    observeModelDrain(id);
                                    if (compactProof === "memoryQueryActiveDrain") {
                                      const entered = yield* Deferred.make<void>();
                                      const release = yield* Deferred.make<void>();
                                      const released = Promise.withResolvers<void>();
                                      yield* Deferred.await(release).pipe(
                                        Effect.andThen(Effect.sync(() => released.resolve())),
                                        Effect.forkChild,
                                      );
                                      const responseBuffer = Response.prototype.arrayBuffer;
                                      const decoder = vi
                                        .spyOn(Response.prototype, "arrayBuffer")
                                        .mockImplementation(async function (this: Response) {
                                          const buffer = await responseBuffer.call(this);
                                          Deferred.doneUnsafe(entered, Effect.void);
                                          await released.promise;
                                          return buffer;
                                        });
                                      const pending =
                                        yield* MemoryModelPorts.exchangeProjectMemoryModel(
                                          exchange,
                                          () => drained.add(id),
                                        ).pipe(
                                          Effect.provideService(
                                            FetchHttpClient.Fetch,
                                            async () =>
                                              new Response(
                                                json({
                                                  model: exchange.model,
                                                  data: [
                                                    {
                                                      index: 0,
                                                      embedding: Array.from(
                                                        { length: 2048 },
                                                        () => 0.375,
                                                      ),
                                                    },
                                                  ],
                                                  usage: { prompt_tokens: 25, total_tokens: 25 },
                                                }),
                                              ),
                                          ),
                                          Effect.forkChild,
                                        );
                                      yield* Effect.gen(function* () {
                                        yield* Deferred.await(entered);
                                        const releasedBefore = [...releasedModelObservations];
                                        const before =
                                          yield* f.sql`SELECT * FROM project_team_model_request WHERE reservation_id=${id}`;
                                        const queries = yield* f.sql<{
                                          id: string;
                                        }>`SELECT query_id AS id FROM project_team_memory_query WHERE status='embedding'`;
                                        if (!queries[0] || !reconcileMemory || !consumeQuery)
                                          return yield* Effect.die("Active query probe missing");
                                        for (const wake of [id, queries[0].id, id])
                                          expect(
                                            (yield* reconcileMemory(wake).pipe(Effect.result))._tag,
                                          ).toBe("Failure");
                                        expect(
                                          (yield* consumer.consumeQuery!(
                                            principal,
                                            queries[0].id,
                                          ).pipe(Effect.result))._tag,
                                        ).toBe("Failure");
                                        expect(releasedModelObservations).toEqual(releasedBefore);
                                        expect(drained.has(id)).toBe(true);
                                        expect(
                                          yield* f.sql`SELECT * FROM project_team_model_request WHERE reservation_id=${id}`,
                                        ).toEqual(before);
                                        expect(
                                          yield* f.sql`SELECT status,result_json,embedding_result_json FROM project_team_memory_query`,
                                        ).toEqual([
                                          {
                                            status: "embedding",
                                            result_json: null,
                                            embedding_result_json: null,
                                          },
                                        ]);
                                      }).pipe(
                                        Effect.ensuring(Deferred.succeed(release, undefined)),
                                      );
                                      return yield* Fiber.join(pending).pipe(
                                        Effect.ensuring(Effect.sync(() => decoder.mockRestore())),
                                      );
                                    }
                                    return {
                                      reportedModel: exchange.model,
                                      inputTokens: 25,
                                      outputTokens: 0,
                                      value: [Array.from({ length: 2048 }, () => 0.375)],
                                    };
                                  }
                                  const saved = yield* f.sql<{
                                    owner: string;
                                    status: string;
                                  }>`SELECT
                                owner_json AS owner,status FROM project_team_memory_job WHERE effect_id=${selection.effectId}`;
                                  expect(saved).toHaveLength(1);
                                  expect(saved[0]?.status).toBe("claimed");
                                  expect(
                                    decodeRequiredJson(saved[0]?.owner ?? "null"),
                                  ).toMatchObject({ commandId: request.commandId });
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
                                  expect(exchange.credential).toBe(
                                    compactProof === "memorySecret" ||
                                      (compactProof === "memoryEmbeddingSecret" &&
                                        exchange.phase === "embed")
                                      ? lateSecret
                                      : "controlled-memory-credential",
                                  );
                                  memoryExchanges += 1;
                                  if (sourceFailure)
                                    return yield* new ProjectMemoryServiceError({
                                      reason:
                                        "Controlled exchange outcome is unknown; cancellation has not drained",
                                    });
                                  drained.add(id);
                                  if (compactProof === "memoryQueryActiveDrain") {
                                    const before =
                                      yield* f.sql`SELECT * FROM project_team_model_request WHERE reservation_id=${id}`;
                                    const wakes = recoveryWakes.length;
                                    if (!reconcileMemory || !consumer.consume)
                                      return yield* Effect.die("Source active probe missing");
                                    for (let wake = 0; wake < 2; wake++)
                                      expect(
                                        (yield* reconcileMemory(selection.effectId).pipe(
                                          Effect.result,
                                        ))._tag,
                                      ).toBe("Failure");
                                    yield* consumer.consume(principal, selection.effectId);
                                    expect(recoveryWakes.length).toBe(wakes);
                                    expect(
                                      yield* f.sql`SELECT * FROM project_team_model_request WHERE reservation_id=${id}`,
                                    ).toEqual(before);
                                  }
                                  if (liquidProof) {
                                    expect(exchange.model).toBe(
                                      exchange.phase === "extract"
                                        ? "liquid/lfm-2.5-2.6b:free"
                                        : "nvidia/nemotron-3-embed-1b:free",
                                    );
                                    const reserved =
                                      yield* f.sql`SELECT provider,model,route_id FROM project_team_model_request WHERE reservation_id=${id}`;
                                    expect(reserved).toEqual([
                                      {
                                        provider: "openrouter",
                                        model: exchange.model,
                                        route_id:
                                          exchange.phase === "extract"
                                            ? "controlled-liquid"
                                            : "controlled-nvidia",
                                      },
                                    ]);
                                  }
                                  if (compactProof === "memoryLiquidConfiguration") {
                                    // Awaited configuration mutation must deny before facts can commit.
                                    yield* Effect.yieldNow;
                                    configuration = {
                                      ...configuration,
                                      extraction: {
                                        ...configuration.extraction,
                                        endpoint:
                                          "https://api.commandcode.ai/provider/v1/chat/completions",
                                      },
                                    };
                                  }
                                  return {
                                    reportedModel:
                                      compactProof === "memoryLiquidIdentity"
                                        ? "liquid/lfm-2.5-2.6b"
                                        : exchange.model,
                                    inputTokens: 50,
                                    outputTokens: exchange.phase === "extract" ? 5 : 0,
                                    value:
                                      exchange.phase === "extract"
                                        ? [
                                            {
                                              key: "parser-provenance",
                                              body:
                                                "The approved parser retains exact provenance." +
                                                (compactProof === "memoryEmbeddingSecret"
                                                  ? " " + lateSecret
                                                  : ""),
                                              quote: "exact parser provenance",
                                            },
                                            ...(queryMixed
                                              ? [
                                                  {
                                                    key: "obsolete-parser",
                                                    body: "Obsolete parser fact must not enter context.",
                                                    quote: "exact parser provenance",
                                                  },
                                                ]
                                              : []),
                                          ]
                                        : Array.from({ length: queryMixed ? 2 : 1 }, () =>
                                            Array.from({ length: 2048 }, () => 0.125),
                                          ),
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
                                  if (envelope.operation === "delete-source") {
                                    expect(cleanupProof).toBe(true);
                                    expect(memoryExchanges).toBe(0);
                                    expect(envelope.input).toEqual({
                                      environmentId: f.binding.environmentId,
                                      projectId,
                                      sourceRecordId: expectedCleanupSelection.sourceRecordId,
                                      sourceRevision: expectedCleanupSelection.sourceRevision,
                                      sourceGeneration: expectedCleanupSelection.sourceGeneration,
                                    });
                                    expect(
                                      yield* f.sql`SELECT owner_json,status FROM project_team_memory_job
                                    WHERE effect_id=${expectedCleanupSelection.effectId}`,
                                    ).toMatchObject([
                                      { owner_json: expect.any(String), status: "claimed" },
                                    ]);
                                    expect(
                                      yield* f.sql`SELECT reservation_id FROM project_team_model_request WHERE request_lane='memory'`,
                                    ).toEqual([]);
                                    return new TextEncoder().encode(
                                      json({
                                        protocolVersion: 1,
                                        requestId: envelope.requestId,
                                        operation: envelope.operation,
                                        result: { cleanupComplete: true },
                                      }),
                                    );
                                  }
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
                              queryCompanion: (owner, _configuration, bytes) =>
                                Effect.gen(function* () {
                                  const envelope = yield* decodeQueryCompanionInput(
                                    new TextDecoder().decode(bytes),
                                  );
                                  expect(envelope.input.limit).toBe(12);
                                  if (sharedQuery) {
                                    expect(envelope.input.projectId).toBe(sharedOwnerId);
                                    expect(owner.operation.projectId).toBe(projectId);
                                    expect(owner.operation.taskId).toBe(f.binding.taskId);
                                    expect(envelope.input.source).toEqual({
                                      sourceRecordId: sharedSelection?.sourceRecordId,
                                      sourceRevision: sharedSelection?.sourceRevision,
                                      sourceGeneration: sharedSelection?.sourceGeneration,
                                    });
                                    expect(owner.sharedSource).toMatchObject({
                                      ownerProjectId: sharedOwnerId,
                                      selection: sharedSelection,
                                      sourceSha256: expect.any(String),
                                    });
                                  }
                                  expect(envelope.input.vector).toEqual(
                                    Array.from({ length: 2048 }, () => 0.375),
                                  );
                                  expect(owner.operation.operationId).toBe(
                                    input.operation.operationId,
                                  );
                                  expect(
                                    yield* f.sql`SELECT status FROM project_team_memory_query`,
                                  ).toEqual([{ status: "searching" }]);
                                  const state = yield* readCurrentState(
                                    f.sql,
                                    sharedQuery ? sharedOwnerId : projectId,
                                  );
                                  const observation = sharedQuery
                                    ? sharedObservation
                                    : state.foundationRecords?.find(
                                        (record) =>
                                          record.kind === "memory-observation" &&
                                          record.sourceId === selection.sourceRecordId &&
                                          (!queryMixed || record.status === "current"),
                                      );
                                  if (observation?.kind !== "memory-observation")
                                    return yield* Effect.die(
                                      "Query fixture has no indexed observation",
                                    );
                                  const obsolete = queryMixed
                                    ? state.foundationRecords?.find(
                                        (record) =>
                                          record.kind === "memory-observation" &&
                                          record.observationKey === "obsolete-parser" &&
                                          record.status === "superseded",
                                      )
                                    : undefined;
                                  if (queryMixed && obsolete?.kind !== "memory-observation")
                                    return yield* Effect.die(
                                      "Mixed backend has no genuinely superseded candidate",
                                    );
                                  memoryBackendCalls++;
                                  if (searchUnknown)
                                    return yield* new MemoryBackendError({
                                      code: "unavailable",
                                      message: "Controlled query search is unknown",
                                    });
                                  if (sharedDeliveryDenied && !sharedBeforeSearchDenied) {
                                    yield* f.sql`UPDATE project_lifecycle SET state='active' WHERE project_id=${sharedOwnerId}`;
                                    const ownerState = yield* readCurrentState(
                                      f.sql,
                                      sharedOwnerId,
                                    );
                                    const source = ownerState.foundationRecords?.find(
                                      (r) =>
                                        r.kind === "memory-source" &&
                                        r.recordId === sharedSelection?.sourceRecordId,
                                    );
                                    if (source?.kind !== "memory-source")
                                      return yield* Effect.die("Missing delayed source");
                                    yield* gateway
                                      .write(
                                        yield* decodeSharedQueryShares({
                                          type: "project-team.memory.shares.replace",
                                          projectId: sharedOwnerId,
                                          commandId: "revoke-inflight-query",
                                          expectedRevision: ownerState.revision,
                                          ...projectMemorySourceSelection(source),
                                          sharedWithProjectIds: [],
                                        }),
                                        { kind: "human", id: "shared-owner-human" },
                                        { kind: "web", id: "shared-owner-web" },
                                      )
                                      .pipe(
                                        Effect.provideService(ProjectWorkVerificationRequest, {
                                          assertCurrent: () => Effect.void,
                                        }),
                                      );
                                  }
                                  queryDrains.add(envelope.requestId);
                                  return new TextEncoder().encode(
                                    json({
                                      protocolVersion: 1,
                                      requestId: envelope.requestId,
                                      operation: "search",
                                      result: {
                                        candidates: [
                                          {
                                            environmentId: owner.operation.environmentId,
                                            projectId: observation.projectId,
                                            sourceRecordId: observation.sourceId,
                                            sourceRevision: observation.sourceRevision,
                                            sourceGeneration: observation.sourceGeneration,
                                            extractionId: observation.extractionId,
                                            observationId: observation.recordId,
                                            score: 0.9,
                                          },
                                          ...(obsolete?.kind === "memory-observation"
                                            ? [
                                                {
                                                  environmentId: owner.operation.environmentId,
                                                  projectId,
                                                  sourceRecordId: obsolete.sourceId,
                                                  sourceRevision: obsolete.sourceRevision,
                                                  sourceGeneration: obsolete.sourceGeneration,
                                                  extractionId: obsolete.extractionId,
                                                  observationId: obsolete.recordId,
                                                  score: 0.8,
                                                },
                                              ]
                                            : []),
                                        ],
                                      },
                                    }),
                                  );
                                }).pipe(
                                  Effect.mapError(
                                    () =>
                                      new MemoryBackendError({
                                        code: "unavailable",
                                        message: "Controlled query backend is unavailable",
                                      }),
                                  ),
                                ),
                              confirmQueryTransportDrained: (id) =>
                                Effect.gen(function* () {
                                  if (compactProof === "memoryQueryActiveDrain") {
                                    const queries = yield* f.sql<{
                                      id: string;
                                    }>`SELECT query_id AS id FROM project_team_memory_query WHERE status='searching'`;
                                    if (!queries[0] || !reconcileMemory || !consumeQuery)
                                      return yield* Effect.die("Searching query probe missing");
                                    for (let wake = 0; wake < 2; wake++)
                                      expect(
                                        (yield* reconcileMemory(queries[0].id).pipe(Effect.result))
                                          ._tag,
                                      ).toBe("Failure");
                                    expect(
                                      (yield* consumer.consumeQuery!(principal, queries[0].id).pipe(
                                        Effect.result,
                                      ))._tag,
                                    ).toBe("Failure");
                                    expect(
                                      yield* f.sql`SELECT status,result_json FROM project_team_memory_query`,
                                    ).toEqual([{ status: "searching", result_json: null }]);
                                  }
                                  return yield* queryDrains.has(id)
                                    ? Effect.void
                                    : Effect.fail(
                                        new ProjectMemoryServiceError({
                                          reason: "Controlled query drain absent",
                                        }),
                                      );
                                }).pipe(
                                  Effect.mapError((error) =>
                                    isMemoryRecoveryError(error)
                                      ? error
                                      : new ProjectMemoryServiceError({
                                          reason: "Controlled query drain SQL failed",
                                        }),
                                  ),
                                ),
                            };
                            if (companionProof) {
                              const storeRoot = yield* f.fs.makeTempDirectoryScoped();
                              const configuredCompanion = {
                                ...configuration.companion,
                                storeRoot,
                                runtimeFiles: [
                                  {
                                    source: yield* f.fs.realPath("/usr/bin/true"),
                                    target: "/runtime/python",
                                  },
                                  {
                                    source: yield* f.fs.realPath(
                                      new URL(
                                        "../../projectWork/memory/companion/mem0_backend.py",
                                        import.meta.url,
                                      ).pathname,
                                    ),
                                    target: "/runtime/mem0.py",
                                  },
                                ],
                              };
                              configuration = { ...configuration, companion: configuredCompanion };
                              queryConfiguration = {
                                ...queryConfiguration,
                                companion: configuredCompanion,
                              };
                              let respond: (
                                bytes: Uint8Array,
                              ) => ReturnType<
                                ProjectMemoryProcessingConsumerOptions["companion"]
                              > = () => Effect.die("Missing controlled response");
                              const fixtureProcessError = (error: unknown) =>
                                isControlledProcessError(error)
                                  ? error
                                  : new ManagedProcess.PiManagedProcessError({
                                      phase: "quarantine",
                                      message: "Controlled companion journal failed",
                                    });
                              let launches = 0;
                              const observed = new Map<string, ManagedProcess.PiManagedDrain>();
                              const host = yield* makeProjectMemoryCompanion({
                                environmentId: "environment",
                                protectedRoots: f.options.protectedRoots,
                                assertAdmission: Effect.void,
                                launch: (_launch, persistence) =>
                                  Effect.gen(function* () {
                                    if (!persistence)
                                      return yield* Effect.die("Companion omitted persistence");
                                    const allocation = persistence.allocation;
                                    yield* persistence.claimActivation(allocation);
                                    const retainedJournal =
                                      yield* makeProjectMemoryCompanionJournal("environment").pipe(
                                        Effect.provideService(SqlClient.SqlClient, f.sql),
                                      );
                                    yield* rejected(
                                      f.sql.withTransaction(
                                        retainedJournal.auditProjectDrained(projectId),
                                      ),
                                    );
                                    if (compactProof === "memoryCompanionIndex" && launches === 0) {
                                      const originals = yield* f.sql<{
                                        intent: string;
                                      }>`SELECT intent_json AS intent FROM project_memory_companion_invocation WHERE json_extract(intent_json,'$.allocation.unit')=${allocation.unit}`;
                                      expect(originals).toHaveLength(1);
                                      const original = yield* decodeProjectMemoryCompanionIntent(
                                        originals[0]!.intent,
                                      );
                                      const corrupt = {
                                        ...original,
                                        invocationId: "corrupt-companion-header",
                                        requestId: "corrupt-header-request",
                                      };
                                      const held =
                                        yield* f.sql`SELECT unit,nonce,memory_bytes,drain_json FROM project_task_resource_child ORDER BY unit`;
                                      let oversizedTransferred = false;
                                      const observedSql = new Proxy(f.sql, {
                                        apply(target, _receiver, args) {
                                          return target(args[0], ...args.slice(1)).pipe(
                                            Effect.tap((rows) =>
                                              Effect.sync(() => {
                                                for (const row of rows)
                                                  if (
                                                    typeof row.project_id === "string" &&
                                                    Buffer.byteLength(row.project_id) > 1024
                                                  )
                                                    oversizedTransferred = true;
                                              }),
                                            ),
                                          );
                                        },
                                      });
                                      const resources = yield* makeProjectTaskResources(
                                        "environment",
                                      ).pipe(
                                        Effect.provideService(SqlClient.SqlClient, observedSql),
                                      );
                                      const rolledBack = yield* f.sql
                                        .withTransaction(
                                          Effect.gen(function* () {
                                            yield* f.sql`INSERT INTO project_memory_companion_invocation(invocation_id,environment_id,project_id,task_id,effect_id,request_id,generation,intent_json,phase) VALUES(${corrupt.invocationId},'environment',${"x".repeat(1048576)},${original.owner.operation.taskId},${original.owner.admittedEffect.effectId},${corrupt.requestId},${corrupt.generation},${canonicalProjectWorkPayload(corrupt)},'prepared')`;
                                            yield* rejected(
                                              resources
                                                .memoryCompanion(corrupt.invocationId, allocation)
                                                .reserve.pipe(
                                                  Effect.provideService(
                                                    SqlClient.SqlClient,
                                                    observedSql,
                                                  ),
                                                ),
                                            );
                                            expect(oversizedTransferred).toBe(false);
                                            expect(
                                              yield* f.sql`SELECT unit,nonce,memory_bytes,drain_json FROM project_task_resource_child ORDER BY unit`,
                                            ).toEqual(held);
                                            return yield* new ProjectMemoryServiceError({
                                              reason: "Rollback disposable corrupt header",
                                            });
                                          }),
                                        )
                                        .pipe(Effect.result);
                                      expect(rolledBack).toMatchObject({
                                        _tag: "Failure",
                                        failure: { reason: "Rollback disposable corrupt header" },
                                      });
                                      expect(
                                        yield* f.sql`SELECT invocation_id FROM project_memory_companion_invocation WHERE invocation_id=${corrupt.invocationId}`,
                                      ).toEqual([]);
                                      expect(launches).toBe(0);
                                    }
                                    launches++;
                                    const owner: ManagedProcess.PiManagedProcessOwner = {
                                      type: "owner",
                                      unit: allocation.unit,
                                      nonce: allocation.nonce,
                                      invocation: "1".repeat(32),
                                      cgroup: `/sys/fs/cgroup/controlled/${allocation.unit}`,
                                      pid: 200,
                                      memoryBytes: allocation.policy.memoryBytes,
                                      swapBytes: 0,
                                      oomGroup: 1,
                                    };
                                    const receipt: ManagedProcess.PiManagedDrain = {
                                      unit: owner.unit,
                                      invocation: owner.invocation,
                                      cgroup: owner.cgroup,
                                      ownerPid: owner.pid,
                                      memoryBytes: owner.memoryBytes,
                                      swapBytes: 0,
                                      oomGroup: 1,
                                      launcherPid: 201,
                                      childPid: startFailure && activeQuery ? null : 202,
                                      childExitCode: startFailure && activeQuery ? null : 0,
                                      kernel: "populated 0\n",
                                    };
                                    observed.set(allocation.unit, receipt);
                                    const output = yield* Deferred.make<
                                      Uint8Array,
                                      ManagedProcess.PiManagedProcessError
                                    >();
                                    const inputChunks: Uint8Array[] = [];
                                    const exited = Deferred.await(output).pipe(
                                      Effect.andThen(
                                        Effect.gen(function* () {
                                          if (compactProof === "memoryCompanionDelete") {
                                            const invocation = (yield* retainedJournal.retained(
                                              expectedCleanupSelection.effectId,
                                            )).find(
                                              (row) =>
                                                row.intent.allocation.unit === allocation.unit,
                                            );
                                            if (!invocation)
                                              return yield* Effect.die(
                                                "Controlled cleanup invocation missing",
                                              );
                                            const resources = yield* makeProjectTaskResources(
                                              "environment",
                                            ).pipe(
                                              Effect.provideService(SqlClient.SqlClient, f.sql),
                                            );
                                            // A genuine matched cleanup port can retain the smaller receipt first.
                                            yield* f.sql.withTransaction(
                                              resources
                                                .memoryCompanion(
                                                  invocation.intent.invocationId,
                                                  allocation,
                                                )
                                                .drain({
                                                  state: "drained",
                                                  unit: owner.unit,
                                                  invocation: owner.invocation,
                                                  cgroup: owner.cgroup,
                                                  kernel: "removed",
                                                }),
                                            );
                                          }
                                          yield* persistence.afterDrain?.(receipt) ?? Effect.void;
                                        }).pipe(
                                          Effect.mapError(
                                            () =>
                                              new ManagedProcess.PiManagedProcessError({
                                                phase: "quarantine",
                                                message: "Controlled drain persistence failed",
                                              }),
                                          ),
                                        ),
                                      ),
                                      Effect.as(receipt),
                                    );
                                    yield* Effect.gen(function* () {
                                      if (expiryFailure && activeQuery) {
                                        const beforeExpiry = yield* Clock.currentTimeMillis;
                                        if (persistence.deadlineAtMs === undefined)
                                          return yield* Effect.die(
                                            "Original companion deadline missing",
                                          );
                                        yield* TestClock.setTime(persistence.deadlineAtMs);
                                        yield* rejected(persistence.beforeStart(owner));
                                        expect(
                                          yield* f.sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE authority_kind='memory-companion' AND drain_json IS NULL`,
                                        ).toEqual([{ held: 16777216 }]);
                                        expect(
                                          yield* f.sql`SELECT phase,owner_json FROM project_memory_companion_invocation WHERE json_extract(intent_json,'$.allocation.unit')=${allocation.unit}`,
                                        ).toMatchObject([
                                          { phase: "owned", owner_json: expect.any(String) },
                                        ]);
                                        yield* (
                                          persistence.afterDrain?.(receipt) ??
                                            Effect.die("Missing expired cleanup port")
                                        );
                                        expect(
                                          yield* f.sql`SELECT COUNT(*) AS held FROM project_task_resource_child WHERE authority_kind='memory-companion' AND drain_json IS NULL`,
                                        ).toEqual([{ held: 0 }]);
                                        // Restore the outer fixture clock; the original invocation limits remain immutable.
                                        yield* TestClock.setTime(beforeExpiry);
                                        return yield* new ManagedProcess.PiManagedProcessError({
                                          phase: "startup",
                                          message: "Original deadline denied START",
                                        });
                                      }
                                      if (!captureFailure || !activeQuery)
                                        return yield* persistence
                                          .beforeStart(owner)
                                          .pipe(Effect.as(202));
                                      yield* f.sql`CREATE TABLE companion_capture_parent(id INTEGER PRIMARY KEY)`;
                                      yield* f.sql`CREATE TABLE companion_capture_child(parent_id INTEGER REFERENCES companion_capture_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
                                      yield* f.sql`CREATE TRIGGER companion_capture_fail AFTER UPDATE OF owner_json ON project_memory_companion_invocation WHEN NEW.owner_json IS NOT NULL BEGIN INSERT INTO companion_capture_child VALUES(1); END`;
                                      const failed = yield* persistence
                                        .beforeStart(owner)
                                        .pipe(Effect.exit);
                                      expect(failed._tag).toBe("Failure");
                                      expect(
                                        yield* f.sql`SELECT owner_json,phase FROM project_memory_companion_invocation WHERE json_extract(intent_json,'$.allocation.unit')=${allocation.unit}`,
                                      ).toEqual([{ owner_json: null, phase: "activating" }]);
                                      expect(
                                        yield* f.sql`SELECT owner_json,drain_json FROM project_task_resource_child WHERE unit=${allocation.unit}`,
                                      ).toEqual([{ owner_json: null, drain_json: null }]);
                                      // Failed cleanup COMMIT retains both original journals and the reservation.
                                      expect(
                                        (yield* (
                                          persistence.afterDrain?.(receipt) ??
                                          Effect.die("Missing drain port")
                                        ).pipe(Effect.exit))._tag,
                                      ).toBe("Failure");
                                      expect(
                                        yield* f.sql`SELECT owner_json,drain_json FROM project_task_resource_child WHERE unit=${allocation.unit}`,
                                      ).toEqual([{ owner_json: null, drain_json: null }]);
                                      expect(
                                        yield* f.sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE authority_kind='memory-companion' AND drain_json IS NULL`,
                                      ).toEqual([{ held: 16777216 }]);
                                      yield* f.sql`DROP TRIGGER companion_capture_fail`;
                                      yield* rejected(
                                        persistence.afterDrain?.({
                                          ...receipt,
                                          invocation: "2".repeat(32),
                                        }) ?? Effect.die("Missing drain port"),
                                      );
                                      expect(
                                        yield* f.sql`SELECT owner_json,drain_json FROM project_task_resource_child WHERE unit=${allocation.unit}`,
                                      ).toEqual([{ owner_json: null, drain_json: null }]);
                                      yield* (
                                        persistence.afterDrain?.(receipt) ??
                                          Effect.die("Missing drain port")
                                      );
                                      expect(
                                        yield* f.sql`SELECT owner_json,drain_json FROM project_task_resource_child WHERE unit=${allocation.unit}`,
                                      ).toMatchObject([
                                        {
                                          owner_json: expect.any(String),
                                          drain_json: expect.any(String),
                                        },
                                      ]);
                                      return yield* new ManagedProcess.PiManagedProcessError({
                                        phase: "startup",
                                        message:
                                          "Original START denied after owner persistence rollback",
                                      });
                                    });
                                    return {
                                      owner,
                                      start: Effect.succeed(202),
                                      send: (bytes) =>
                                        Effect.sync(() => {
                                          expect(bytes.byteLength).toBeLessThanOrEqual(8192);
                                          inputChunks.push(bytes);
                                        }),
                                      endInput: Effect.gen(function* () {
                                        const requestBytes = new Uint8Array(
                                          Buffer.concat(inputChunks),
                                        );
                                        // The real Mem0 adapter encodes these insertion-ordered wire bytes.
                                        expect(
                                          new TextDecoder()
                                            .decode(requestBytes)
                                            .startsWith('{"protocolVersion":1,"requestId":'),
                                        ).toBe(true);
                                        const returned = yield* respond(requestBytes).pipe(
                                          Effect.mapError(
                                            (error) =>
                                              new ManagedProcess.PiManagedProcessError({
                                                phase: "transport",
                                                message: error.message,
                                              }),
                                          ),
                                        );
                                        const text = new TextDecoder()
                                          .decode(returned)
                                          .replace('"score":0.9', '"score":1.0')
                                          .replace('"score":0.8', '"score":1e-06');
                                        yield* Deferred.succeed(
                                          output,
                                          new TextEncoder().encode(text + "\n"),
                                        );
                                      }),
                                      stdout: Stream.fromEffect(Deferred.await(output)),
                                      stderr: Stream.empty,
                                      awaitExit: exited,
                                      stop: exited,
                                    } satisfies ManagedProcess.PiManagedProcess;
                                  }).pipe(Effect.mapError(fixtureProcessError)),
                                reconcile: (recovery) =>
                                  Effect.gen(function* () {
                                    if (compactProof !== "memoryCompanionRecovery")
                                      return yield* Effect.die(
                                        "Completed controlled invocation must not probe native controls",
                                      );
                                    if (!queryDrains.size)
                                      return yield* new ManagedProcess.PiManagedProcessError({
                                        phase: "quarantine",
                                        message: "Controlled kernel remains populated",
                                      });
                                    const receipt = observed.get(recovery.allocation.unit);
                                    if (!receipt)
                                      return yield* Effect.die(
                                        "Controlled recovery has no observed physical owner",
                                      );
                                    expect(recovery.owner).toMatchObject({
                                      unit: receipt.unit,
                                      invocation: receipt.invocation,
                                      cgroup: receipt.cgroup,
                                    });
                                    expect(
                                      yield* f.sql`SELECT SUM(memory_bytes) AS held FROM project_task_resource_child WHERE authority_kind='memory-companion' AND drain_json IS NULL`,
                                    ).toEqual([{ held: 16777216 }]);
                                    return {
                                      state: "drained" as const,
                                      unit: receipt.unit,
                                      invocation: receipt.invocation,
                                      cgroup: receipt.cgroup,
                                      kernel: receipt.kernel,
                                    };
                                  }).pipe(Effect.mapError(fixtureProcessError)),
                              });
                              const controlled = consumerOptions.companion;
                              const controlledQuery = consumerOptions.queryCompanion;
                              const invoke: typeof host.companion = (owner, config, bytes, fence) =>
                                Effect.gen(function* () {
                                  respond = (chunk) =>
                                    owner.version === 1
                                      ? controlled(owner, config, chunk, fence)
                                      : controlledQuery === undefined
                                        ? Effect.die("Missing query responder")
                                        : controlledQuery(owner, config, chunk, fence);
                                  if (launches === 0) {
                                    yield* rejected(
                                      host.companion(
                                        owner,
                                        {
                                          ...config,
                                          companion: { ...config.companion, runtimeFiles: [] },
                                        },
                                        bytes,
                                        fence,
                                      ),
                                    );
                                    yield* rejected(
                                      host.companion(
                                        owner,
                                        {
                                          ...config,
                                          companion: {
                                            ...config.companion,
                                            storeRoot:
                                              owner.operation.allocation.launch.workspace.path,
                                          },
                                        },
                                        bytes,
                                        fence,
                                      ),
                                    );
                                    expect(launches).toBe(0);
                                  }
                                  const returned = yield* host.companion(
                                    owner,
                                    config,
                                    bytes,
                                    fence,
                                  );
                                  const originalLaunches = launches;
                                  const journal = yield* makeProjectMemoryCompanionJournal(
                                    "environment",
                                  ).pipe(Effect.provideService(SqlClient.SqlClient, f.sql));
                                  const retained = yield* journal.retained(
                                    owner.admittedEffect.effectId,
                                  );
                                  expect(
                                    retained.every(
                                      (row) =>
                                        row.phase === "drained" &&
                                        row.owner !== undefined &&
                                        row.drain !== null,
                                    ),
                                  ).toBe(true);
                                  const requestId =
                                    owner.version === 1
                                      ? (yield* decodeMemoryCompanionInput(
                                          new TextDecoder().decode(bytes),
                                        )).requestId
                                      : (yield* decodeQueryCompanionInput(
                                          new TextDecoder().decode(bytes),
                                        )).requestId;
                                  const latest = retained.find(
                                    (row) => row.intent.requestId === requestId,
                                  );
                                  if (!latest?.owner)
                                    return yield* Effect.die("Controlled host lost original owner");
                                  if (sharedQuery && owner.version === 2) {
                                    const namespace = projectMemoryHash([
                                      owner.operation.environmentId,
                                      sharedOwnerId,
                                    ]);
                                    expect(
                                      latest.intent.allocation.launch.nativeState?.path,
                                    ).toContain(namespace);
                                  }
                                  const observedReceipt = observed.get(
                                    latest.intent.allocation.unit,
                                  );
                                  if (!observedReceipt)
                                    return yield* Effect.die(
                                      "Controlled host lost original receipt",
                                    );
                                  yield* rejected(
                                    journal.drain(latest.intent, {
                                      ...observedReceipt,
                                      invocation: "2".repeat(32),
                                    }),
                                  );
                                  yield* rejected(
                                    journal.drain(latest.intent, {
                                      ...observedReceipt,
                                      kernel: "populated 1\npopulated 0\n",
                                    }),
                                  );
                                  yield* rejected(
                                    host.companion(
                                      owner,
                                      {
                                        ...config,
                                        companion: {
                                          ...config.companion,
                                          memoryBytes: config.companion.memoryBytes * 2,
                                        },
                                      },
                                      bytes,
                                      fence,
                                    ),
                                  );
                                  expect(
                                    yield* f.sql`SELECT unit FROM project_task_resource_child WHERE authority_kind='memory-companion' AND drain_json IS NULL`,
                                  ).toEqual([]);
                                  // Exact bytes replay, while changed bytes, owner and current-fence failure deny.
                                  expect(
                                    yield* host.companion(owner, config, bytes, fence),
                                  ).toEqual(returned);
                                  yield* rejected(
                                    host.companion(
                                      owner,
                                      config,
                                      new Uint8Array(Buffer.concat([bytes, Buffer.from(" ")])),
                                      fence,
                                    ),
                                  );
                                  yield* rejected(
                                    host.companion(
                                      {
                                        ...owner,
                                        operation: { ...owner.operation, environmentId: "foreign" },
                                      },
                                      config,
                                      bytes,
                                      fence,
                                    ),
                                  );
                                  yield* rejected(
                                    host.companion(
                                      owner,
                                      config,
                                      bytes,
                                      fence.pipe(
                                        Effect.andThen(
                                          Effect.fail(
                                            new ProjectMemoryServiceError({
                                              reason: "Revoked controlled forward fence",
                                            }),
                                          ),
                                        ),
                                      ),
                                    ),
                                  );
                                  expect(launches).toBe(originalLaunches);
                                  yield* host.cleanup(owner.admittedEffect.effectId);
                                  expect(
                                    yield* f.sql.withTransaction(
                                      journal.auditProjectDrained(projectId),
                                    ),
                                  ).toBeGreaterThan(0);
                                  yield* rejected(
                                    f.sql.withTransaction(
                                      journal.auditProjectDrained(projectId, 0),
                                    ),
                                  );
                                  return returned;
                                }).pipe(
                                  Effect.mapError((error) =>
                                    isControlledBackendError(error)
                                      ? error
                                      : new MemoryBackendError({
                                          code: "unavailable",
                                          message: "Controlled companion observation failed",
                                        }),
                                  ),
                                );
                              consumerOptions = {
                                ...consumerOptions,
                                companion: invoke,
                                queryCompanion: invoke,
                                confirmCompanionTransportDrained: host.cleanup,
                                confirmQueryTransportDrained: host.confirmSearchDrain,
                              };
                            }
                            if (serverProof) {
                              const controlledExchange = consumerOptions.exchange;
                              let transport: ReturnType<
                                typeof MemoryModelPorts.exchangeProjectMemoryModel
                              > = Effect.die("Production memory transport was not selected");
                              const transportSpy = vi
                                .spyOn(MemoryModelPorts, "exchangeProjectMemoryModel")
                                .mockImplementation(() => transport);
                              yield* Effect.addFinalizer(() =>
                                Effect.sync(() => transportSpy.mockRestore()),
                              );
                              const productionExchange = makeProjectMemoryModelExchange(
                                Effect.void,
                                (id) => drained.add(id),
                              );
                              consumerOptions = {
                                ...consumerOptions,
                                exchange: (request, id, assertCurrent) =>
                                  Effect.suspend(() => {
                                    transport = Effect.gen(function* () {
                                      expect(
                                        Option.isNone(
                                          yield* Effect.serviceOption(f.sql.transactionService),
                                        ),
                                      ).toBe(true);
                                      return yield* controlledExchange(request, id, assertCurrent);
                                    });
                                    forwardingAtServer = true;
                                    return productionExchange(request, id, assertCurrent).pipe(
                                      Effect.ensuring(
                                        Effect.sync(() => {
                                          forwardingAtServer = false;
                                        }),
                                      ),
                                    );
                                  }),
                              };
                            }
                            confirmMemoryDrain = consumerOptions.confirmModelTransportDrained;
                            const consumer = yield* makeProjectMemoryProcessingConsumer(
                              consumerOptions,
                            ).pipe(Effect.provideService(ProjectWorkContentGuard, contentGuard));
                            consumeMemory = (principal, effectId) =>
                              consumer.consume === undefined
                                ? Effect.die("Configured consumer missing")
                                : Effect.gen(function* () {
                                    const captured =
                                      yield* Effect.serviceOption(ProjectMemoryOperation);
                                    if (Option.isSome(captured))
                                      capturedMemoryOperation = captured.value;
                                    if (consumer.consume === undefined)
                                      return yield* Effect.die("Configured consumer missing");
                                    return yield* probeForward(
                                      consumer.consume(principal, effectId),
                                      false,
                                    );
                                  }).pipe(
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
                            const restart = makeProjectMemoryProcessingConsumer(
                              consumerOptions,
                            ).pipe(Effect.provideService(ProjectWorkContentGuard, contentGuard));
                            const restartContext =
                              yield* Effect.context<Effect.Services<typeof restart>>();
                            restartMemoryConsumer = restart.pipe(
                              Effect.provide(restartContext),
                              Effect.map((restarted) => {
                                reconcileMemory = restarted.reconcileTransportDrain;
                              }),
                            );
                            reconcileMemory = consumer.reconcileTransportDrain;
                            recoverMemory = consumer.recoverJoinedOperation;
                            consumeQuery =
                              consumer.consumeQuery === undefined
                                ? undefined
                                : (principal, queryId) =>
                                    consumer.consumeQuery === undefined
                                      ? Effect.die("Configured query consumer missing")
                                      : (compactProof === "memoryQueryInterruptedRecovery"
                                          ? Effect.gen(function* () {
                                              if (!consumer.consumeQuery)
                                                return yield* Effect.die(
                                                  "Interrupt query port missing",
                                                );
                                              const child = yield* consumer
                                                .consumeQuery(principal, queryId)
                                                .pipe(Effect.forkChild);
                                              yield* Deferred.await(queryInterrupted);
                                              const before =
                                                yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`;
                                              expect(
                                                (yield* consumer
                                                  .consumeQuery(principal, queryId)
                                                  .pipe(Effect.result))._tag,
                                              ).toBe("Failure");
                                              yield* Fiber.interrupt(child);
                                              const interrupted = yield* Fiber.await(child);
                                              expect(interrupted._tag).toBe("Failure");
                                              if (interrupted._tag === "Failure")
                                                expect(Cause.hasInterrupts(interrupted.cause)).toBe(
                                                  true,
                                                );
                                              expect(
                                                yield* f.sql`SELECT status,result_json FROM project_team_memory_query`,
                                              ).toEqual([
                                                { status: "uncertain", result_json: null },
                                              ]);
                                              expect(
                                                yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`,
                                              ).toEqual(before);
                                            }).pipe(Effect.orDie)
                                          : probeForward(
                                              consumer.consumeQuery(principal, queryId),
                                              true,
                                            )
                                        ).pipe(
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
                            readQueryCache = consumer.readQueryCache;
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
                          if (liquidDenied) {
                            expect(jobs[0]).toMatchObject({ status: "uncertain", receipt: null });
                            expect(memoryExchanges).toBe(1);
                            expect(memoryBackendCalls).toBe(0);
                            const current = yield* readCurrentState(f.sql, projectId);
                            expect(
                              current.foundationRecords?.filter(
                                (r) => r.kind === "memory-observation",
                              ),
                            ).toEqual([]);
                            expect(
                              current.foundationRecords?.find(
                                (r) => r.kind === "memory-extraction",
                              ),
                            ).toMatchObject({
                              status: "pending",
                              extractionModel: "inclusionai/ling-3.1-flash:free",
                            });
                            expect(memoryPipelineError).toBeDefined();
                          } else if (forwardProof && !forwardQuery) {
                            expect(forwardChecks).toBe(1);
                            expect(memoryExchanges).toBe(
                              compactProof === "memoryForwardExtract" ||
                                compactProof === "memoryServerExtract"
                                ? 0
                                : compactProof === "memoryForwardEmbed" ||
                                    compactProof === "memoryServerEmbed"
                                  ? 1
                                  : 2,
                            );
                            expect(memoryBackendCalls).toBe(0);
                            expect(
                              yield* f.sql`SELECT status FROM project_team_memory_job WHERE effect_id=${selection.effectId}`,
                            ).toEqual([{ status: "uncertain" }]);
                            forwardDeniedObserved = true;
                          } else if (cleanupProof) {
                            expect({ failure: memoryPipelineFailure }).toEqual({ failure: "" });
                            expect(jobs[0]?.status).toBe("settled");
                            expect(decodeRequiredJson(jobs[0]?.receipt ?? "null")).toMatchObject({
                              kind: "delete-source-complete",
                              sourceId: selection.sourceRecordId,
                              sourceRevision: selection.sourceRevision,
                              sourceGeneration: selection.sourceGeneration,
                              observationIds: [],
                            });
                            expect(memoryExchanges).toBe(0);
                            expect(memoryBackendCalls).toBe(1);
                            expect(
                              yield* f.sql`SELECT reservation_id FROM project_team_model_request WHERE request_lane='memory'`,
                            ).toEqual([]);
                            const reflected = yield* readCurrentState(f.sql, projectId);
                            expect(
                              reflected.foundationRecords?.find(
                                (entry) =>
                                  entry.kind === "effect" && entry.effectId === selection.effectId,
                              ),
                            ).toMatchObject({ status: "succeeded" });
                            expect(
                              reflected.foundationRecords?.find(
                                (entry) => entry.recordId === selection.sourceRecordId,
                              ),
                            ).toMatchObject({
                              status: humanRetraction ? "retracted" : "superseded",
                            });
                            expect(
                              reflected.decisions?.find(
                                (entry) =>
                                  entry.decisionId ===
                                  (humanRetraction
                                    ? "live-memory-decision"
                                    : "live-memory-decision-replacement"),
                              ),
                            ).toMatchObject({ state: "accepted" });
                          } else if ((pipelineProof && !forwardProof) || queryForward) {
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
                            ).toHaveLength(queryMixed ? 2 : 1);
                            if (liquidProof) {
                              expect(
                                observed.find((r) => r.kind === "memory-extraction"),
                              ).toMatchObject({
                                status: "indexed",
                                extractionModel: "liquid/lfm-2.5-2.6b:free",
                              });
                              expect(yield* readRecordedUsage()).toMatchObject([
                                { availability: "available" },
                              ]);
                            }
                            if (queryMixed) {
                              const obsolete = observed.find(
                                (record) =>
                                  record.kind === "memory-observation" &&
                                  record.observationKey === "obsolete-parser",
                              );
                              if (obsolete?.kind !== "memory-observation")
                                return yield* Effect.die(
                                  "Mixed query fixture has no original obsolete observation",
                                );
                              const before = yield* readCurrentState(f.sql, projectId);
                              yield* f.repository.execute(
                                yield* decodeRequiredFoundation({
                                  type: "project-work.foundation.commit",
                                  commandId: "live-query-observation-superseded",
                                  projectId,
                                  expectedRevision: before.revision,
                                  attribution,
                                  committedAt: at,
                                  records: [
                                    {
                                      ...obsolete,
                                      revision: obsolete.revision + 1,
                                      status: "superseded",
                                      updatedAt: at,
                                    },
                                  ],
                                }),
                              );
                              expect(
                                (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
                                  (record) => record.recordId === obsolete.recordId,
                                ),
                              ).toMatchObject({
                                kind: "memory-observation",
                                status: "superseded",
                                revision: obsolete.revision + 1,
                              });
                              expect(
                                yield* f.sql`SELECT status FROM project_team_memory_observation WHERE record_id=${obsolete.recordId}`,
                              ).toEqual([{ status: "superseded" }]);
                            }
                            if (forwardQuery) {
                              activeQuery = true;
                              yield* issueQuery();
                              activeQuery = false;
                            }
                            if (queryNoForward) {
                              if (queryBudget)
                                queryConfiguration = {
                                  ...queryConfiguration,
                                  embedding: {
                                    ...queryConfiguration.embedding,
                                    maximumInputTokens: 1000,
                                  },
                                };
                              activeQuery = true;
                              yield* issueQuery();
                              activeQuery = false;
                              expect(memoryPipelineError).toMatchObject({
                                reason: queryBudget
                                  ? "Original memory operation, attempt or root budget exhausted"
                                  : "Query fence denied",
                              });
                              const queries = yield* f.sql<{
                                id: string;
                                status: string;
                                result: string;
                                embedding: string;
                              }>`
                                SELECT query_id AS id,status,result_json AS result,embedding_json AS embedding FROM project_team_memory_query`;
                              const retained = queries[0];
                              if (
                                retained === undefined ||
                                queryRequest === undefined ||
                                queryReceipt === undefined
                              )
                                return yield* Effect.die(
                                  "Original budget-denied query receipt missing",
                                );
                              expect(decodeRequiredJson(retained.embedding)).toMatchObject({
                                maximumInputTokens: queryBudget ? 999 : 400,
                                maximumOutputTokens: 1,
                              });
                              expect(
                                yield* f.sql`SELECT reservation_id FROM project_team_model_request WHERE request_lane='memory'
                                AND json_extract(reservation_json,'$.effectId')=${retained.id}`,
                              ).toEqual([]);
                              expect(
                                yield* gateway.write(
                                  queryRequest,
                                  principal.actor,
                                  { kind: "mcp", id: input.identity.workerId },
                                  principal,
                                ),
                              ).toEqual(queryReceipt);
                              expect(memoryExchanges).toBe(2);
                              expect(memoryBackendCalls).toBe(3);
                              expect(
                                (yield* f.reader.readRequired(snapshot)).observations.provenance
                                  .queryId,
                              ).toBeUndefined();
                            }
                            if (sharedDeliveryDenied) {
                              activeQuery = true;
                              yield* issueQuery();
                              activeQuery = false;
                              expect(memoryPipelineError).toMatchObject({
                                reason: "Shared source grant or exact current tuple changed",
                              });
                              const queries = yield* f.sql<{
                                id: string;
                                status: string;
                              }>`SELECT query_id AS id,status FROM project_team_memory_query`;
                              expect(queries).toMatchObject([{ status: "uncertain" }]);
                              if (!queries[0] || reconcileMemory === undefined)
                                return yield* Effect.die("Missing delayed query cleanup");
                              yield* reconcileMemory(queries[0].id);
                              expect(
                                yield* f.sql`SELECT status FROM project_team_memory_query`,
                              ).toEqual([{ status: "failed" }]);
                              expect(
                                (yield* f.reader.readRequired(snapshot)).observations.provenance
                                  .queryId,
                              ).toBeUndefined();
                              expect(
                                (yield* f.reader.readRequired(snapshot)).observations.records.every(
                                  (r) => r.projectId !== sharedOwnerId,
                                ),
                              ).toBe(true);
                              expect(memoryExchanges).toBe(3);
                              expect(memoryBackendCalls).toBe(sharedBeforeSearchDenied ? 3 : 4);
                            }
                            if (queryCache) {
                              const beforeCommit = yield* readCurrentState(f.sql, projectId);
                              const task = beforeCommit.tasks.find(
                                (entry) => entry.taskId === f.binding.taskId,
                              );
                              if (task === undefined)
                                return yield* Effect.die("Failed-COMMIT query task missing");
                              const beforeCharges =
                                yield* f.sql`SELECT * FROM project_team_model_request`;
                              yield* f.sql`CREATE TEMP TABLE query_commit_parent (id INTEGER PRIMARY KEY)`;
                              yield* f.sql`CREATE TEMP TABLE query_commit_child
                                (id INTEGER REFERENCES query_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
                              yield* f.sql`CREATE TEMP TRIGGER query_commit_fault AFTER INSERT ON project_team_memory_query
                                BEGIN INSERT INTO query_commit_child (id) VALUES (1); END`;
                              const badQuery = yield* decodeMemoryQueryRequest({
                                type: "project-team.memory.query",
                                commandId: "live-query-failed-commit",
                                projectId,
                                taskId: task.taskId,
                                expectedRevision: beforeCommit.revision,
                                expectedTaskRevision: task.revision,
                                specRevision: task.specRevision,
                                planRevision: f.binding.planRevision,
                                query: "Which retained facts explain parser provenance?",
                              });
                              const badInput = { arguments: { intentJSON: json(badQuery) } };
                              const failedCommit = yield* Effect.tryPromise({
                                try: () =>
                                  input.executeBridgeTool(
                                    {
                                      type: "tool-call",
                                      callId: 87,
                                      nativeCallId: "failed-commit-query",
                                      lifecycleId: 1,
                                      toolName: "project_work_write",
                                      execution: "bridge",
                                      input: {
                                        transferId: "failed-commit-query",
                                        totalBytes: Buffer.byteLength(json(badInput)),
                                      },
                                    },
                                    badInput,
                                    signal,
                                  ),
                                catch: controlledCallbackError,
                              }).pipe(Effect.result);
                              expect(failedCommit._tag).toBe("Failure");
                              // A driver may already have rolled back its failed COMMIT. Both
                              // cases must leave the actual authoritative rows unchanged.
                              yield* f.sql`ROLLBACK`.pipe(Effect.result);
                              yield* f.sql`DROP TRIGGER query_commit_fault`;
                              expect(yield* readCurrentState(f.sql, projectId)).toEqual(
                                beforeCommit,
                              );
                              expect(
                                yield* f.sql`SELECT * FROM project_team_model_request`,
                              ).toEqual(beforeCharges);
                              expect(yield* f.sql`SELECT * FROM project_team_memory_query`).toEqual(
                                [],
                              );
                              expect(
                                yield* f.sql`SELECT * FROM project_work_command_receipts WHERE project_id=${projectId}
                                AND command_id=${badQuery.commandId}`,
                              ).toEqual([]);
                              expect(memoryExchanges).toBe(2);
                              expect(memoryBackendCalls).toBe(3);
                              activeQuery = true;
                              yield* issueQuery();
                              activeQuery = false;
                              expect(
                                yield* f.sql`SELECT status FROM project_team_memory_query`,
                              ).toEqual([{ status: "completed" }]);
                              const calls = {
                                exchanges: memoryExchanges,
                                backend: memoryBackendCalls,
                              };
                              if (compactProof === "memoryQueryDrainCapacity") {
                                const charges =
                                  yield* f.sql`SELECT * FROM project_team_model_request`;
                                expect(memoryDrains.size).toBe(255);
                                // The production dropping Set must still accept the next local drain.
                                observeModelDrain("later-confirmed-drain");
                                if (confirmMemoryDrain === undefined)
                                  return yield* Effect.die("Model drain confirmation missing");
                                yield* confirmMemoryDrain("later-confirmed-drain");
                                expect(memoryDrains.size).toBe(256);
                                expect({
                                  exchanges: memoryExchanges,
                                  backend: memoryBackendCalls,
                                }).toEqual(calls);
                                expect(
                                  yield* f.sql`SELECT * FROM project_team_model_request`,
                                ).toEqual(charges);
                              }
                              const context = yield* f.reader.readRequired(snapshot);
                              expect(context.observations.provenance.queryId).toEqual(
                                expect.any(String),
                              );
                              expect(context.text).toContain("completed semantic query");
                              expect(context.text).toContain(
                                "The approved parser retains exact provenance.",
                              );
                              if (queryMixed) {
                                expect(context.observations.records).toHaveLength(1);
                                expect(context.observations.records[0]?.body).toBe(
                                  "The approved parser retains exact provenance.",
                                );
                                expect(context.text).not.toContain(
                                  "Obsolete parser fact must not enter context.",
                                );
                                expect(context.observations.omitted).toContain(
                                  "Observation candidates excluded by current source or correction policy",
                                );
                              }
                              expect({
                                exchanges: memoryExchanges,
                                backend: memoryBackendCalls,
                              }).toEqual(calls);
                              const queryId = context.observations.provenance.queryId;
                              if (queryId === undefined || queryRequest === undefined)
                                return yield* Effect.die(
                                  "Completed semantic query identity missing",
                                );
                              const finals = yield* f.sql<{
                                ids: string;
                                result: string;
                              }>`SELECT event_ids_json AS ids,result_json AS result
                                FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id=${queryId + ":result"}`;
                              expect(finals).toHaveLength(1);
                              expect(decodeRequiredJson(finals[0]?.ids ?? "null")).toEqual([
                                queryId + ":result:project-work:0",
                              ]);
                              expect(decodeRequiredJson(finals[0]?.result ?? "null")).toMatchObject(
                                { receipt: { status: "accepted", eventCount: 1 } },
                              );
                              const expectFallback = Effect.fn("controlledQuery.expectFallback")(
                                function* () {
                                  const fallback = yield* f.reader.readRequired(snapshot);
                                  expect(fallback.required).toEqual(context.required);
                                  expect(fallback.observations.provenance.queryId).toBeUndefined();
                                  expect(fallback.text).not.toContain("completed semantic query");
                                  if (sharedQuery)
                                    expect(
                                      fallback.observations.records.every(
                                        (r) => r.projectId !== sharedOwnerId,
                                      ),
                                    ).toBe(true);
                                  expect({
                                    exchanges: memoryExchanges,
                                    backend: memoryBackendCalls,
                                  }).toEqual(calls);
                                },
                              );
                              const expectCorruptLedgerDenied = Effect.fn(
                                "controlledQuery.expectCorruptLedgerDenied",
                              )(function* () {
                                const denied = yield* f.reader
                                  .readRequired(snapshot)
                                  .pipe(Effect.result);
                                expect(denied._tag).toBe("Failure");
                                if (denied._tag === "Failure")
                                  expect(denied.failure).toMatchObject({
                                    _tag: "ProjectTeamContextError",
                                  });
                                expect({
                                  exchanges: memoryExchanges,
                                  backend: memoryBackendCalls,
                                }).toEqual(calls);
                              });
                              yield* f.sql`UPDATE project_team_memory_query SET status='failed' WHERE query_id=${queryId}`;
                              expect(
                                (yield* auditProjectMemoryOperationLedger(f.sql, {
                                  environmentId: f.binding.environmentId,
                                  projectId,
                                  bindingId: f.binding.recordId,
                                  generation: f.binding.generation,
                                  operationId: input.operation.operationId,
                                }).pipe(Effect.result))._tag,
                              ).toBe("Failure");
                              yield* expectCorruptLedgerDenied();
                              yield* f.sql`UPDATE project_team_memory_query SET status='completed' WHERE query_id=${queryId}`;
                              expect(
                                (yield* f.sql`UPDATE project_team_memory_query SET result_json='{}' WHERE query_id=${queryId}`.pipe(
                                  Effect.result,
                                ))._tag,
                              ).toBe("Failure");
                              yield* f.sql`UPDATE project_work_command_receipts SET event_ids_json='[]'
                                WHERE project_id=${projectId} AND command_id=${queryId + ":result"}`;
                              yield* expectCorruptLedgerDenied();
                              if (finals[0] === undefined)
                                return yield* Effect.die("Original query final receipt missing");
                              yield* f.sql`UPDATE project_work_command_receipts SET event_ids_json=${finals[0].ids}
                                WHERE project_id=${projectId} AND command_id=${queryId + ":result"}`;
                              expect(
                                (yield* f.reader.readRequired(snapshot)).observations.provenance
                                  .queryId,
                              ).toBe(queryId);
                              const originalConfiguration = queryConfiguration;
                              queryConfiguration = {
                                ...queryConfiguration,
                                embedding: {
                                  ...queryConfiguration.embedding,
                                  routeId: "changed-query-route",
                                },
                              };
                              yield* expectFallback();
                              queryConfiguration = originalConfiguration;
                              if (sharedQuery) {
                                expect(
                                  (yield* f.reader.readRequired(snapshot)).observations.records,
                                ).toEqual([sharedObservation]);
                                expect(context.observations.records[0]?.projectId).toBe(
                                  sharedOwnerId,
                                );
                                expect(
                                  yield* f.sql`SELECT project_id FROM project_team_memory_query`,
                                ).toEqual([{ project_id: projectId }]);
                                expect(
                                  yield* f.sql`SELECT project_id FROM project_team_memory_observation WHERE record_id=${sharedObservation?.recordId ?? "missing"}`,
                                ).toEqual([{ project_id: sharedOwnerId }]);
                                const currentOwner = yield* readCurrentState(f.sql, sharedOwnerId);
                                const currentSource = currentOwner.foundationRecords?.find(
                                  (r) =>
                                    r.kind === "memory-source" &&
                                    r.recordId === sharedSelection?.sourceRecordId,
                                );
                                if (currentSource?.kind !== "memory-source")
                                  return yield* Effect.die("Shared cache source missing");
                                if (compactProof === "memoryQuerySharedRevokeCache") {
                                  yield* f.sql`UPDATE project_lifecycle SET state='active' WHERE project_id=${sharedOwnerId}`;
                                  yield* gateway
                                    .write(
                                      yield* decodeSharedQueryShares({
                                        type: "project-team.memory.shares.replace",
                                        projectId: sharedOwnerId,
                                        commandId: "human-revoke-query-source",
                                        expectedRevision: currentOwner.revision,
                                        ...projectMemorySourceSelection(currentSource),
                                        sharedWithProjectIds: [],
                                      }),
                                      { kind: "human", id: "shared-owner-human" },
                                      { kind: "web", id: "shared-owner-web" },
                                    )
                                    .pipe(
                                      Effect.provideService(ProjectWorkVerificationRequest, {
                                        assertCurrent: () => Effect.void,
                                      }),
                                    );
                                } else if (compactProof === "memoryQuerySharedDeleteCache") {
                                  yield* f.sql`UPDATE projection_projects SET deleted_at=${at} WHERE project_id=${sharedOwnerId}`;
                                } else if (compactProof === "memoryQuerySharedTombstoneCache") {
                                  yield* f.sql`UPDATE project_lifecycle SET state='tombstoned' WHERE project_id=${sharedOwnerId}`;
                                } else if (compactProof === "memoryQuerySharedSupersedeCache") {
                                  yield* f.repository.execute(
                                    yield* decodeRequiredFoundation({
                                      type: "project-work.foundation.commit",
                                      projectId: sharedOwnerId,
                                      commandId: "shared-query-superseded",
                                      expectedRevision: currentOwner.revision,
                                      attribution,
                                      committedAt: at,
                                      records: [
                                        {
                                          ...currentSource,
                                          revision: currentSource.revision + 1,
                                          status: "superseded",
                                        },
                                      ],
                                    }),
                                  );
                                }
                                if (compactProof?.endsWith("Cache")) yield* expectFallback();
                              }
                              yield* queryGuard.registerKnownSecrets([queryRequest.query]);
                              yield* expectFallback();
                            }
                            if (joinedRecovery) {
                              activeQuery = true;
                              yield* issueQuery();
                              activeQuery = false;
                            }
                            if (queryRecovery && !joinedRecovery) {
                              activeQuery = true;
                              yield* issueQuery();
                              activeQuery = false;
                              expect(memoryPipelineError).toMatchObject({
                                reason:
                                  compactProof === "memoryQueryModelUnknown"
                                    ? "Query embedding is uncertain; no resend"
                                    : "Query search is uncertain; no resend",
                              });
                              const queries = yield* f.sql<{
                                id: string;
                                owner: string;
                                embedding: string;
                                embedded: string;
                                search: string | null;
                                searched: string | null;
                              }>`SELECT query_id AS id,owner_json AS owner,embedding_json AS embedding,
                                embedding_result_json AS embedded,search_json AS search,search_result_json AS searched
                                FROM project_team_memory_query`;
                              const retained = queries[0];
                              if (
                                retained === undefined ||
                                reconcileMemory === undefined ||
                                queryRequest === undefined ||
                                queryReceipt === undefined
                              )
                                return yield* Effect.die(
                                  "Original query recovery association missing",
                                );
                              const modelRows = yield* f.sql<{
                                id: string;
                                reservation: string;
                                settlement: string;
                                receipt: string;
                                capacity: string;
                              }>`SELECT reservation_id AS id,reservation_json AS reservation,settlement_json AS settlement,
                                accounting_receipt_id AS receipt,capacity_state AS capacity FROM project_team_model_request
                                WHERE request_lane='memory' AND json_extract(reservation_json,'$.effectId')=${retained.id}`;
                              const model = modelRows[0];
                              if (model === undefined)
                                return yield* Effect.die("Original query reservation missing");
                              expect(modelRows).toHaveLength(1);
                              expect(model.capacity).toBe(
                                compactProof === "memoryQueryModelUnknown"
                                  ? "quarantine"
                                  : "released",
                              );
                              expect(decodeRequiredJson(model.settlement)).toMatchObject({
                                outcome:
                                  compactProof === "memoryQueryModelUnknown"
                                    ? "unknown"
                                    : "reported",
                                chargedInputTokens:
                                  compactProof === "memoryQueryModelUnknown" ? 400 : 25,
                                chargedOutputTokens:
                                  compactProof === "memoryQueryModelUnknown" ? 1 : 0,
                                transportDrained: compactProof !== "memoryQueryModelUnknown",
                              });
                              const calls = {
                                exchanges: memoryExchanges,
                                backend: memoryBackendCalls,
                              };
                              expect(
                                (yield* auditProjectMemoryOperationLedger(f.sql, {
                                  environmentId: f.binding.environmentId,
                                  projectId,
                                  bindingId: f.binding.recordId,
                                  generation: f.binding.generation,
                                  operationId: input.operation.operationId,
                                })).settled,
                              ).toBe(false);
                              const waitingContext = yield* f.reader.readRequired(snapshot);
                              expect(waitingContext.required.taskId).toBe(f.binding.taskId);
                              expect(
                                waitingContext.observations.provenance.queryId,
                              ).toBeUndefined();
                              expect(waitingContext.text).not.toContain("completed semantic query");
                              expect({
                                exchanges: memoryExchanges,
                                backend: memoryBackendCalls,
                              }).toEqual(calls);
                              expect(
                                yield* gateway.write(
                                  queryRequest,
                                  principal.actor,
                                  { kind: "mcp", id: input.identity.workerId },
                                  principal,
                                ),
                              ).toEqual(queryReceipt);
                              const cleanupId =
                                compactProof === "memoryQueryModelUnknown" ? model.id : retained.id;
                              const releasesBeforeRecovery = [...releasedModelObservations];
                              if (!startFailure) {
                                expect(
                                  (yield* reconcileMemory(cleanupId).pipe(Effect.result))._tag,
                                ).toBe("Failure");
                              }
                              expect(
                                yield* f.sql`SELECT result_json,search_drain_json FROM project_team_memory_query`,
                              ).toEqual([{ result_json: null, search_drain_json: null }]);
                              expect(
                                yield* f.sql`SELECT reservation_json AS reservation,settlement_json AS settlement,
                                accounting_receipt_id AS receipt,capacity_state AS capacity,reservation_id AS id
                                FROM project_team_model_request WHERE reservation_id=${model.id}`,
                              ).toEqual(modelRows);
                              expect(releasedModelObservations).toEqual(releasesBeforeRecovery);
                              // This is an observed completion handshake, rather than cancellation or an abort request.
                              if (compactProof === "memoryQueryModelUnknown")
                                memoryDrains.add(model.id);
                              else queryDrains.add(retained.id + ":search");
                              if (compactProof === "memoryQueryModelUnknown") {
                                const admission = yield* f.sql<{
                                  ids: string;
                                }>`SELECT event_ids_json AS ids
                                  FROM project_work_command_receipts WHERE project_id=${projectId}
                                  AND command_id=${queryRequest.commandId}`;
                                if (admission[0] === undefined)
                                  return yield* Effect.die("Query admission receipt missing");
                                yield* f.sql`UPDATE project_work_command_receipts SET event_ids_json='[]'
                                  WHERE project_id=${projectId} AND command_id=${queryRequest.commandId}`;
                                expect(
                                  (yield* reconcileMemory(cleanupId).pipe(Effect.result))._tag,
                                ).toBe("Failure");
                                expect(releasedModelObservations).toEqual(releasesBeforeRecovery);
                                expect(memoryDrains.has(model.id)).toBe(true);
                                expect(
                                  yield* f.sql`SELECT capacity_state FROM project_team_model_request
                                  WHERE reservation_id=${model.id}`,
                                ).toEqual([{ capacity_state: "quarantine" }]);
                                yield* f.sql`UPDATE project_work_command_receipts SET event_ids_json=${admission[0].ids}
                                  WHERE project_id=${projectId} AND command_id=${queryRequest.commandId}`;
                              }
                              if (restartMemoryConsumer === undefined)
                                return yield* Effect.die("Restarted memory consumer missing");
                              yield* restartMemoryConsumer;
                              yield* reconcileMemory(cleanupId);
                              expect(memoryDrains.has(model.id)).toBe(false);
                              expect(releasedModelObservations).toContain(model.id);
                              expect(
                                (yield* auditProjectMemoryOperationLedger(f.sql, {
                                  environmentId: f.binding.environmentId,
                                  projectId,
                                  bindingId: f.binding.recordId,
                                  generation: f.binding.generation,
                                  operationId: input.operation.operationId,
                                })).settled,
                              ).toBe(true);
                              expect(
                                yield* f.sql`SELECT query_id AS id,owner_json AS owner,embedding_json AS embedding,
                                embedding_result_json AS embedded,search_json AS search,search_result_json AS searched
                                FROM project_team_memory_query`,
                              ).toEqual(queries);
                              const finalRows = yield* f.sql<{
                                result: string;
                                drain: string | null;
                                status: string;
                              }>`
                                SELECT result_json AS result,search_drain_json AS drain,status FROM project_team_memory_query`;
                              expect(finalRows[0]?.status).toBe("failed");
                              expect(
                                decodeRequiredJson(finalRows[0]?.result ?? "null"),
                              ).toMatchObject({
                                kind: "memory-query-result",
                                queryId: retained.id,
                                outcome: "failed",
                                hitIds: [],
                              });
                              if (searchUnknown)
                                expect(
                                  decodeRequiredJson(finalRows[0]?.drain ?? "null"),
                                ).toMatchObject({
                                  queryId: retained.id,
                                  requestId: retained.id + ":search",
                                  transportDrained: true,
                                });
                              const settled = yield* f.sql<{
                                reservation: string;
                                settlement: string;
                                receipt: string;
                                capacity: string;
                              }>`
                                SELECT reservation_json AS reservation,settlement_json AS settlement,
                                accounting_receipt_id AS receipt,capacity_state AS capacity FROM project_team_model_request
                                WHERE reservation_id=${model.id}`;
                              expect(settled[0]).toMatchObject({
                                reservation: model.reservation,
                                receipt: model.receipt,
                                capacity: "released",
                              });
                              expect(decodeRequiredJson(settled[0]?.settlement ?? "null")).toEqual({
                                ...decodeQueryRecoverySettlement(model.settlement),
                                transportDrained: true,
                              });
                              const admissions =
                                yield* f.sql`SELECT * FROM project_work_command_receipts
                                WHERE project_id=${projectId} AND command_id=${queryRequest.commandId}`;
                              const completion =
                                yield* f.sql`SELECT * FROM project_work_command_receipts
                                WHERE project_id=${projectId} AND command_id=${retained.id + ":result"}`;
                              expect(completion).toHaveLength(1);
                              const releasesAfterRecovery = [...releasedModelObservations];
                              yield* restartMemoryConsumer;
                              for (const wake of [cleanupId, retained.id, model.id])
                                yield* reconcileMemory(wake);
                              expect(releasedModelObservations).toEqual(releasesAfterRecovery);
                              expect(
                                yield* f.sql`SELECT * FROM project_work_command_receipts
                                WHERE project_id=${projectId} AND command_id=${queryRequest.commandId}`,
                              ).toEqual(admissions);
                              expect(
                                yield* f.sql`SELECT * FROM project_work_command_receipts
                                WHERE project_id=${projectId} AND command_id=${retained.id + ":result"}`,
                              ).toEqual(completion);
                              expect({
                                exchanges: memoryExchanges,
                                backend: memoryBackendCalls,
                              }).toEqual(calls);
                              const recovered = yield* f.reader.readRequired(snapshot);
                              expect(recovered.observations.provenance.queryId).toBeUndefined();
                              expect(recovered.text).not.toContain("completed semantic query");
                            }
                            expect(
                              observed.find((row) => row.kind === "memory-extraction"),
                            ).toMatchObject({ status: "indexed" });
                            const available = yield* gateway
                              .read(
                                {
                                  operation: "memory-sources",
                                  projectId,
                                  taskId: f.binding.taskId,
                                },
                                principal,
                              )
                              .pipe(Effect.flatMap(decodeMemorySources));
                            expect(available.items[0]?.status).toBe("indexed");
                          } else if (sourceFailure) {
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
                              return yield* Effect.die(
                                "Original unknown memory reservation absent",
                              );
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
                          } else if (
                            compactProof === "memorySecret" ||
                            compactProof === "memoryEmbeddingSecret"
                          ) {
                            expect(jobs[0]).toMatchObject({ status: "uncertain", receipt: null });
                            expect(memoryReceipt.receipt.status).toBe("accepted");
                            const expectedStages = compactProof === "memorySecret" ? 0 : 1;
                            expect(memoryExchanges).toBe(expectedStages);
                            expect(memoryBackendCalls).toBe(0);
                            expect(
                              yield* f.sql`SELECT status,capacity_state,request_scope FROM project_team_model_request
                            WHERE request_lane='memory'`,
                            ).toHaveLength(expectedStages);
                            expect(memoryPipelineError).toMatchObject({
                              reason:
                                compactProof === "memorySecret"
                                  ? "Selected source failed content safety"
                                  : "Memory embedding text failed content safety",
                            });
                          } else
                            expect(jobs[0]).toMatchObject({ status: "pending", receipt: null });
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
                          if (pipelineProof && !forwardProof) {
                            expect(memoryExchanges).toBe(2);
                            expect(memoryBackendCalls).toBe(3);
                          } else if (sourceFailure) {
                            expect(memoryExchanges).toBe(1);
                            expect(memoryBackendCalls).toBe(0);
                          } else if (cleanupProof) {
                            expect(memoryExchanges).toBe(0);
                            expect(memoryBackendCalls).toBe(1);
                          }
                          if (humanRetraction) {
                            // Project deletion also requires the independently captured
                            // current comment. Select it explicitly on the same running owner.
                            const beforeComment = yield* readCurrentState(f.sql, projectId);
                            const human = { kind: "human" as const, id: "live-memory-human" };
                            yield* gateway
                              .write(
                                {
                                  type: "project-team.memory.retract",
                                  commandId: CommandId.make("live-memory-comment-retract"),
                                  projectId,
                                  expectedRevision: beforeComment.revision,
                                  sourceRecordId: commentSource.recordId,
                                  expectedSourceRecordRevision: commentSource.revision,
                                  sourceRevision: commentSource.sourceRevision,
                                  sourceGeneration: commentSource.generation,
                                  contentHash: commentSource.contentHash,
                                },
                                human,
                                { kind: "web", id: "live-memory-browser" },
                                { actor: human },
                              )
                              .pipe(
                                Effect.provideService(
                                  ProjectWorkVerificationRequest,
                                  ProjectWorkVerificationRequest.of({
                                    assertCurrent: (caller, id, permission) =>
                                      caller.actor.kind === "human" &&
                                      caller.managed === undefined &&
                                      id === projectId &&
                                      permission === "write"
                                        ? Effect.void
                                        : Effect.fail(
                                            new ProjectWorkVerificationRequestError({
                                              reason: "denied",
                                            }),
                                          ),
                                  }),
                                ),
                              );
                            const remaining = yield* gateway
                              .read(
                                { operation: "memory-sources", projectId, taskId: task.taskId },
                                principal,
                              )
                              .pipe(Effect.flatMap(decodeMemorySources));
                            const secondSelection = remaining.items.find(
                              (entry) => entry.selection.sourceRecordId === commentSource.recordId,
                            )?.selection;
                            const current = yield* readCurrentState(f.sql, projectId);
                            const currentTask = current.tasks.find(
                              (entry) => entry.taskId === task.taskId,
                            );
                            if (secondSelection === undefined || currentTask === undefined)
                              return yield* Effect.die(
                                "Exact current comment cleanup selection missing",
                              );
                            const secondRequest = yield* decodeMemoryOwnerRequest({
                              type: "project-team.memory.process",
                              commandId: "live-memory-comment-cleanup-select",
                              projectId,
                              taskId: currentTask.taskId,
                              expectedRevision: current.revision,
                              expectedTaskRevision: currentTask.revision,
                              specRevision: currentTask.specRevision,
                              planRevision: f.binding.planRevision,
                              selection: secondSelection,
                            });
                            const secondInput = { arguments: { intentJSON: json(secondRequest) } };
                            expectedCleanupSelection = secondSelection;
                            const secondCall = {
                              ...call,
                              callId: 2,
                              nativeCallId: "live-memory-comment-cleanup-select",
                              input: {
                                transferId: "live-memory-comment-cleanup-input",
                                totalBytes: Buffer.byteLength(json(secondInput)),
                              },
                            };
                            const second = yield* Effect.tryPromise({
                              try: () => input.executeBridgeTool(secondCall, secondInput, signal),
                              catch: controlledCallbackError,
                            });
                            if (second.kind !== "text")
                              return yield* Effect.die(
                                "Comment cleanup returned no retained receipt",
                              );
                            expect((yield* decodeReportReceipt(second.text)).receipt.status).toBe(
                              "accepted",
                            );
                            expect(
                              yield* f.sql`SELECT status,json_extract(receipt_json,'$.kind') AS kind
                              FROM project_team_memory_job WHERE effect_id=${secondSelection.effectId}`,
                            ).toEqual([{ status: "settled", kind: "delete-source-complete" }]);
                            expect((yield* readCurrentState(f.sql, projectId)).comments).toEqual(
                              beforeComment.comments,
                            );
                            expect(memoryExchanges).toBe(0);
                            expect(memoryBackendCalls).toBe(2);
                            expect(
                              yield* f.sql`SELECT reservation_id FROM project_team_model_request WHERE request_lane='memory'`,
                            ).toEqual([]);
                          }
                          if (accountingProof) {
                            const admitted = yield* decodeMemoryLedgerOwner(
                              jobs[0]?.owner ?? "null",
                            );
                            const operations = yield* makeProjectTeamPiOperations({
                              environmentId: "environment",
                            });
                            const drainedMemory = new Set<string>();
                            let extractionEndpoint: ProjectMemoryProcessingConfiguration["extraction"]["endpoint"] =
                              liquidProof
                                ? "https://openrouter.ai/api/v1/chat/completions"
                                : "https://api.commandcode.ai/provider/v1/chat/completions";
                            const ledger = yield* makeProjectMemoryModelAccounting({
                              environmentId: "environment",
                              get extractionEndpoint() {
                                return extractionEndpoint;
                              },
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
                                            new ProjectMemoryServiceError({
                                              reason: "Owner drift",
                                            }),
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
                            if (memoryRoot) {
                              expect(admitted.operation.operationMaximumTokens).toBe(childCeiling);
                              const held = yield* ledger.reserve(admitted, {
                                phase: "extract",
                                routeId: "controlled-command-code",
                                requestId: 1,
                                maxInputTokens: 90,
                                maxOutputTokens: 10,
                                deadlineAtMs: row.deadline_at_ms,
                              });
                              const settlement = {
                                ...held.reservation,
                                reservationId: held.reservationId,
                                outcome: "reported" as const,
                                chargedInputTokens: 35,
                                chargedOutputTokens: 5,
                                reportedModel: held.reservation.model,
                                reportedInputTokens: 35,
                                reportedOutputTokens: 5,
                                transportDrained: true,
                              };
                              drainedMemory.add(held.reservationId);
                              if (forgedRoot)
                                yield* f.sql`INSERT INTO project_team_pi_subscription_grant
                                (environment_id,project_id,root_task_id,model,route_id,maximum_tokens,maximum_duration_ms,deadline_at_ms)
                                VALUES('environment',${projectId},${f.snapshot.intent.limits.rootTaskId},'gpt-6-luna','openai-subscription-luna',64000,300000,${admitted.operation.rootDeadlineAtMs})`;
                              if (memoryRootDenied) {
                                const before =
                                  yield* f.sql`SELECT * FROM project_team_model_request`;
                                expect(
                                  (yield* ledger.settle(settlement).pipe(Effect.result))._tag,
                                ).toBe("Failure");
                                expect(
                                  yield* f.sql`SELECT * FROM project_team_model_request`,
                                ).toEqual(before);
                              } else {
                                const fresh = yield* makeProjectTeamContext({
                                  environmentId: "environment",
                                  maximumEnvironmentModelCalls: 128,
                                });
                                const heldContext = yield* f.reader.readRequired(snapshot);
                                expect(
                                  (yield* fresh.readRequired(snapshot)).required.remaining,
                                ).toEqual(heldContext.required.remaining);
                                expect(heldContext.required.remaining).toMatchObject(
                                  hardRoot
                                    ? { rootRemainingTokens: 63_900 }
                                    : {
                                        rootRemainingTokens: 64_000,
                                        policy: {
                                          observedChargedTokens: 0,
                                          nominalHeldTokens: 100,
                                        },
                                      },
                                );
                                expect(yield* readRecordedUsage()).toMatchObject([
                                  {
                                    availability: "available",
                                    root: { chargedTokens: 0, reservedTokens: 100 },
                                  },
                                ]);
                                const before =
                                  yield* f.sql`SELECT * FROM project_team_model_request`;
                                for (const [bindingId, property, corrupt] of [
                                  [f.binding.recordId, "parentRunId", "foreign-parent"],
                                  [
                                    admitted.operation.rootBindingId,
                                    "model",
                                    hardRoot ? "gpt-6-luna" : model,
                                  ],
                                ] as const) {
                                  const events = yield* f.sql<{
                                    id: string;
                                    payload: string;
                                  }>`SELECT event_id AS id,payload_json AS payload
                                    FROM project_work_events WHERE project_id=${projectId}
                                    AND event_type='project-work.foundation.recorded'
                                    AND json_extract(payload_json,'$.record.recordId')=${bindingId}
                                    AND json_extract(payload_json,'$.record.revision')=0`;
                                  if (events.length !== 1 || !events[0])
                                    return yield* Effect.die(
                                      "Exact original ancestry event absent",
                                    );
                                  const event = events[0];
                                  yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,${"$.record." + property},${corrupt})
                                    WHERE event_id=${event.id}`;
                                  expect(
                                    (yield* ledger.settle(settlement).pipe(Effect.result))._tag,
                                  ).toBe("Failure");
                                  expect(
                                    yield* f.sql`SELECT * FROM project_team_model_request`,
                                  ).toEqual(before);
                                  yield* f.sql`UPDATE project_work_events SET payload_json=${event.payload} WHERE event_id=${event.id}`;
                                }
                                const receipt = yield* ledger.settle(settlement);
                                expect(yield* ledger.settle(settlement)).toEqual(receipt);
                                expect(
                                  yield* f.sql`SELECT status,charged_input_tokens,charged_output_tokens FROM project_team_model_request`,
                                ).toEqual([
                                  {
                                    status: "reported",
                                    charged_input_tokens: 35,
                                    charged_output_tokens: 5,
                                  },
                                ]);
                                if (childCeiling === 1000)
                                  expect(
                                    (yield* ledger
                                      .reserve(admitted, {
                                        phase: "extract",
                                        routeId: "controlled-command-code",
                                        requestId: 2,
                                        maxInputTokens: 960,
                                        maxOutputTokens: 1,
                                        deadlineAtMs: row.deadline_at_ms,
                                      })
                                      .pipe(Effect.result))._tag,
                                  ).toBe("Failure");
                                const current = yield* f.reader.readRequired(snapshot);
                                expect(
                                  (yield* fresh.readRequired(snapshot)).required.remaining,
                                ).toEqual(current.required.remaining);
                                expect(current.required.remaining).toMatchObject(
                                  hardRoot
                                    ? { rootRemainingTokens: 63_960 }
                                    : {
                                        rootRemainingTokens: 63_960,
                                        policy: { observedChargedTokens: 40 },
                                      },
                                );
                                if (hardRoot)
                                  expect(current.required.remaining.policy).toBeUndefined();
                                expect(yield* readRecordedUsage()).toMatchObject([
                                  { availability: "available", root: { chargedTokens: 40 } },
                                ]);
                              }
                              memoryRootChecked = true;
                            } else if (subscriptionMemory) {
                              const held = yield* ledger.reserve(admitted, {
                                phase: "extract",
                                routeId: "controlled-command-code",
                                requestId: 1,
                                maxInputTokens: 230,
                                maxOutputTokens: 10,
                                deadlineAtMs: row.deadline_at_ms,
                              });
                              const settlement = {
                                ...held.reservation,
                                reservationId: held.reservationId,
                                outcome: memoryUnknown
                                  ? ("unknown" as const)
                                  : ("reported" as const),
                                chargedInputTokens: 230,
                                chargedOutputTokens: 10,
                                transportDrained: !memoryUnknown,
                                ...(memoryUnknown
                                  ? {}
                                  : {
                                      reportedModel: held.reservation.model,
                                      reportedInputTokens: 230,
                                      reportedOutputTokens: 10,
                                    }),
                              };
                              drainedMemory.add(held.reservationId);
                              if (!settleSubscriptionPi)
                                return yield* Effect.die("Actual Pi producer absent");
                              const piFirst = compactProof === "memorySubscriptionPiFirst";
                              if (piFirst) {
                                yield* settleSubscriptionPi;
                                const originalRows =
                                  yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`;
                                const guards = yield* f.sql<{
                                  sql: string;
                                }>`SELECT sql FROM sqlite_master
                                  WHERE type='trigger' AND name='project_team_pi_subscription_grant_immutable'`;
                                if (!guards[0])
                                  return yield* Effect.die("Original grant guard missing");
                                // Inject damaged storage only in this disposable fixture; production
                                // writes retain the original CHECKs and immutable-grant trigger.
                                yield* f.sql`DROP TRIGGER project_team_pi_subscription_grant_immutable`;
                                yield* f.sql`PRAGMA ignore_check_constraints=ON`;
                                for (const [column, original, corrupt] of [
                                  ["model", "gpt-6-luna", "foreign-model"],
                                  ["route_id", "openai-subscription-luna", "foreign-route"],
                                  ["maximum_tokens", 64_000, 63_999],
                                  ["maximum_duration_ms", 300_000, 299_999],
                                  [
                                    "deadline_at_ms",
                                    admitted.operation.rootDeadlineAtMs,
                                    admitted.operation.rootDeadlineAtMs + 1,
                                  ],
                                  [
                                    "environment_id",
                                    admitted.operation.environmentId,
                                    "foreign-environment",
                                  ],
                                  ["project_id", admitted.operation.projectId, "foreign-project"],
                                  ["root_task_id", admitted.operation.rootTaskId, "foreign-root"],
                                ] as const) {
                                  yield* f.sql`UPDATE project_team_pi_subscription_grant SET ${f.sql(column)}=${corrupt}`;
                                  const corruptGrant =
                                    yield* f.sql`SELECT * FROM project_team_pi_subscription_grant`;
                                  expect(
                                    (yield* ledger.settle(settlement).pipe(Effect.result))._tag,
                                  ).toBe("Failure");
                                  expect(
                                    yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`,
                                  ).toEqual(originalRows);
                                  expect(
                                    yield* f.sql`SELECT * FROM project_team_pi_subscription_grant`,
                                  ).toEqual(corruptGrant);
                                  yield* f.sql`UPDATE project_team_pi_subscription_grant SET ${f.sql(column)}=${original}`;
                                }
                                yield* f.sql`PRAGMA ignore_check_constraints=OFF`;
                                yield* f.sql.unsafe(guards[0].sql);
                                const originalGrant =
                                  yield* f.sql`SELECT * FROM project_team_pi_subscription_grant`;
                                yield* f.sql`CREATE TEMP TRIGGER deny_memory_grant_stop BEFORE UPDATE ON project_team_pi_subscription_grant
                                  BEGIN SELECT RAISE(ABORT,'controlled-grant-stop-failure'); END`;
                                expect(
                                  (yield* ledger.settle(settlement).pipe(Effect.result))._tag,
                                ).toBe("Failure");
                                expect(
                                  yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`,
                                ).toEqual(originalRows);
                                expect(
                                  yield* f.sql`SELECT * FROM project_team_pi_subscription_grant`,
                                ).toEqual(originalGrant);
                                yield* f.sql`DROP TRIGGER deny_memory_grant_stop`;
                              }
                              const settled = yield* ledger.settle(settlement);
                              const beforeReplay =
                                yield* f.sql`SELECT * FROM project_team_pi_subscription_grant`;
                              expect(yield* ledger.settle(settlement)).toEqual(settled);
                              expect(
                                yield* f.sql`SELECT * FROM project_team_pi_subscription_grant`,
                              ).toEqual(beforeReplay);
                              if (piFirst) {
                                expect(yield* readRecordedUsage()).toMatchObject([
                                  { availability: "available", root: { chargedTokens: 64_000 } },
                                ]);
                                expect(
                                  (yield* f.reader.readRequired(snapshot)).required.remaining,
                                ).toMatchObject({
                                  rootRemainingTokens: 0,
                                  policy: {
                                    accountingMode: "openai-subscription-monitored",
                                    stoppedReason: "threshold-reached",
                                    observedChargedTokens: 64_000,
                                  },
                                });
                              }
                              subscriptionMemoryChecked = true;
                              if (memoryUnknown)
                                expect(
                                  yield* f.sql`SELECT status,capacity_state,charged_input_tokens,charged_output_tokens
                                FROM project_team_model_request WHERE reservation_id=${held.reservationId}`,
                                ).toEqual([
                                  {
                                    status: "unknown",
                                    capacity_state: "quarantine",
                                    charged_input_tokens: 230,
                                    charged_output_tokens: 10,
                                  },
                                ]);
                              if (!piFirst) {
                                expect(
                                  (yield* f.reader.readRequired(snapshot)).required.remaining,
                                ).toMatchObject({
                                  rootRemainingTokens: 31_880,
                                  policy: {
                                    observedChargedTokens: 32_120,
                                    nominalHeldTokens: 31_880,
                                  },
                                });
                                expect(
                                  yield* f.sql`SELECT status FROM project_team_model_request WHERE request_lane='pi' AND request_id=2`,
                                ).toEqual([{ status: "held" }]);
                                expect(
                                  yield* f.sql`SELECT stop_reason FROM project_team_pi_subscription_grant`,
                                ).toEqual([{ stop_reason: null }]);
                                yield* settleSubscriptionPi;
                              }
                            } else {
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
                              expect(
                                yield* f.sql`SELECT * FROM project_team_model_request`,
                              ).toEqual(beforeDenied);
                              const memorySettlement = {
                                ...memoryHeld.reservation,
                                reservationId: memoryHeld.reservationId,
                                outcome: "reported" as const,
                                chargedInputTokens: 100,
                                chargedOutputTokens: 10,
                                transportDrained: true,
                                reportedModel: memoryHeld.reservation.model,
                                reportedInputTokens: 100,
                                reportedOutputTokens: 10,
                              };
                              drainedMemory.add(memoryHeld.reservationId);
                              if (liquidProof) {
                                expect(memoryHeld.reservation).toMatchObject({
                                  provider: "openrouter",
                                  model: "liquid/lfm-2.5-2.6b:free",
                                  routeId: stage.routeId,
                                });
                                expect(
                                  (yield* ledger
                                    .settle({ ...memorySettlement, provider: "command-code" })
                                    .pipe(Effect.result))._tag,
                                ).toBe("Failure");
                                for (const wrong of [
                                  "liquid/lfm-2.5-2.6b",
                                  "inclusionai/ling-3.1-flash:free",
                                ])
                                  expect(
                                    (yield* ledger
                                      .settle({ ...memorySettlement, reportedModel: wrong })
                                      .pipe(Effect.result))._tag,
                                  ).toBe("Failure");
                              }
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
                              expect(yield* readRecordedUsage()).toMatchObject([
                                {
                                  availability: "available",
                                  root: {
                                    maximumTokens: 1000,
                                    chargedTokens: 175,
                                    reservedTokens: 0,
                                    unknownChargedTokens: 41,
                                    remainingTokens: 825,
                                    quarantinedCalls: 1,
                                  },
                                  attempt: {
                                    maximumTokens: 1000,
                                    chargedTokens: 175,
                                    unknownChargedTokens: 41,
                                  },
                                  operation: {
                                    operationId: input.operation.operationId,
                                    chargedTokens: 175,
                                  },
                                },
                              ]);
                              if (
                                compactProof === "memoryAccounting" ||
                                compactProof === "memoryLiquidAccounting"
                              ) {
                                const originalJobs =
                                  yield* f.sql`SELECT * FROM project_team_memory_job ORDER BY effect_id`;
                                const originalModels =
                                  yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`;
                                const paddedOwner = json({
                                  ...admitted,
                                  padding: "x".repeat(240000),
                                });
                                expect(Buffer.byteLength(paddedOwner, "utf8")).toBeLessThanOrEqual(
                                  262144,
                                );
                                // Legal SQL metadata clones are not admitted owners. Rollback
                                // preserves the genuine job, and no immutable trigger is bypassed.
                                const bounded = yield* f.sql
                                  .withTransaction(
                                    Effect.gen(function* () {
                                      for (let index = 0; index < 18; index++)
                                        yield* f.sql`INSERT INTO project_team_memory_job
                                    (effect_id,environment_id,project_id,input_json,claim_generation,status,receipt_json,owner_json)
                                    SELECT ${`usage-bound-${index}`},environment_id,project_id,input_json,0,'pending',NULL,${paddedOwner}
                                    FROM project_team_memory_job WHERE effect_id=${selection.effectId}`;
                                      expect(
                                        yield* f.sql`SELECT COUNT(*) AS count FROM project_team_memory_job
                                  WHERE effect_id LIKE 'usage-bound-%'`,
                                      ).toEqual([{ count: 18 }]);
                                      expect(yield* readRecordedUsage()).toMatchObject([
                                        {
                                          availability: "unavailable",
                                          reason: "read-bound",
                                        },
                                      ]);
                                      return yield* Effect.fail(
                                        "controlled-memory-metadata-rollback",
                                      );
                                    }),
                                  )
                                  .pipe(Effect.result);
                                expect(bounded).toMatchObject({
                                  _tag: "Failure",
                                  failure: "controlled-memory-metadata-rollback",
                                });
                                expect(
                                  yield* f.sql`SELECT * FROM project_team_memory_job ORDER BY effect_id`,
                                ).toEqual(originalJobs);
                                expect(
                                  yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`,
                                ).toEqual(originalModels);
                                expect(yield* readRecordedUsage()).toMatchObject([
                                  {
                                    availability: "available",
                                    root: {
                                      chargedTokens: 175,
                                      unknownChargedTokens: 41,
                                      remainingTokens: 825,
                                    },
                                  },
                                ]);
                              }
                              const awaitingDrain = yield* ledger.reserve(admitted, {
                                ...stage,
                                requestId: 3,
                                maxInputTokens: 1,
                                maxOutputTokens: 1,
                              });
                              expect(yield* readRecordedUsage()).toMatchObject([
                                {
                                  availability: "available",
                                  root: {
                                    chargedTokens: 175,
                                    reservedTokens: 2,
                                    remainingTokens: 823,
                                    heldCalls: 1,
                                    quarantinedCalls: 1,
                                    unknownChargedTokens: 41,
                                  },
                                },
                              ]);
                              const afterDrainRequest = {
                                ...stage,
                                phase: "embed" as const,
                                routeId: "controlled-openrouter",
                                requestId: 2,
                                maxInputTokens: 1,
                                maxOutputTokens: 1,
                              };
                              expect(
                                (yield* ledger
                                  .reserve(admitted, afterDrainRequest)
                                  .pipe(Effect.result))._tag,
                              ).toBe("Failure");
                              expect(
                                (yield* ledger
                                  .confirmTransportDrained(
                                    selection.effectId,
                                    embedding.reservationId,
                                  )
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
                              if (liquidProof) {
                                // Auditing follows each saved triple across a route switch.
                                extractionEndpoint =
                                  "https://api.commandcode.ai/provider/v1/chat/completions";
                                const legacy = yield* ledger.reserve(admitted, {
                                  ...stage,
                                  routeId: "legacy-history",
                                  requestId: 4,
                                  maxInputTokens: 1,
                                  maxOutputTokens: 1,
                                });
                                expect(legacy.reservation).toMatchObject({
                                  provider: "command-code",
                                  model: "inclusionai/ling-3.1-flash:free",
                                });
                                drainedMemory.add(legacy.reservationId);
                                yield* ledger.settle({
                                  ...legacy.reservation,
                                  reservationId: legacy.reservationId,
                                  outcome: "reported",
                                  chargedInputTokens: 0,
                                  chargedOutputTokens: 0,
                                  reportedModel: "inclusionai/ling-3.1-flash",
                                  reportedInputTokens: 0,
                                  reportedOutputTokens: 0,
                                  transportDrained: true,
                                });
                                extractionEndpoint =
                                  "https://openrouter.ai/api/v1/chat/completions";
                                expect((yield* ledger.reserve(admitted, stage)).status).toBe(
                                  "existing",
                                );
                                expect(yield* readRecordedUsage()).toMatchObject([
                                  { availability: "available" },
                                ]);
                              }
                              // This is a genuinely accepted broker alias. Its durable
                              // terminal, rather than today's policy, proves it on replay.
                              const aliasRequest = {
                                ...nativeFields,
                                requestId: 3,
                                maxInputTokens: 1,
                                maxOutputTokens: 1,
                              };
                              const aliasHeld = yield* Effect.tryPromise(() =>
                                input.broker.reserveRequest(aliasRequest, signal),
                              );
                              const reportedAlias = nativeFields.model.replace(/:free$/u, "");
                              expect(reportedAlias).not.toBe(nativeFields.model);
                              const aliasUsage = {
                                prompt_tokens: 0,
                                completion_tokens: 0,
                                total_tokens: 0,
                              };
                              const aliasSettled = yield* Effect.tryPromise(() =>
                                input.broker.settleRequest({
                                  ...aliasRequest,
                                  reservationId: aliasHeld.reservationId,
                                  outcome: "reported",
                                  chargedInputTokens: 0,
                                  chargedOutputTokens: 0,
                                  reportedModel: reportedAlias,
                                  reportedUsage: aliasUsage,
                                  transportDrained: true,
                                }),
                              );
                              accountingReceipts.push({
                                requestId: 3,
                                reservationId: aliasHeld.reservationId,
                                accountingReceiptId: aliasSettled.accountingReceiptId,
                                routeId: aliasRequest.routeId,
                                provider: aliasRequest.provider,
                                model: aliasRequest.model,
                                reportedModel: reportedAlias,
                                usage: aliasUsage,
                              });
                              expect(yield* readRecordedUsage()).toMatchObject([
                                {
                                  availability: "unavailable",
                                  reason: "ledger-invalid",
                                },
                              ]);
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
                                {
                                  lane: "memory",
                                  operation: input.operation.operationId,
                                  tokens: 151,
                                },
                                { lane: "pi", operation: input.operation.operationId, tokens: 24 },
                              ]);
                            }
                          }
                        }
                      }
                      const terminal: SessionRuntime.PiSessionTerminal = {
                        identity: input.identity,
                        operation: input.operation,
                        outcome:
                          failedUsage ||
                          (joinedRecovery && input.operation.operationKind === "prompt")
                            ? "failed"
                            : "success",
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
                      if (joinedRecovery && input.operation.operationKind === "prompt")
                        joinedTerminal = terminal;
                      yield* Effect.tryPromise(() => input.persistTerminal(terminal, signal));
                      if (returnProof && input.operation.operationKind === "compact") {
                        if (compactProof === "returnRevoked") {
                          const authority = yield* authorization.issueCredential({
                            providerInstanceId,
                            threadId,
                          });
                          if (!authority) return yield* Effect.die("Missing return authority");
                          yield* restoreHistoricalBinding({
                            ...authority.binding,
                            status: "revoked",
                            revision: authority.binding.revision + 1,
                          });
                        }
                        if (compactProof === "returnExpired")
                          yield* TestClock.setTime(
                            input.persistence.deadlineAtMs ??
                              (yield* Effect.die("Missing compact deadline")),
                          );
                        if (compactProof === "returnWorkspace") {
                          yield* f.fs.rename(f.binding.worktree, f.binding.worktree + "-replaced");
                          yield* f.fs.makeDirectory(f.binding.worktree);
                        }
                        if (selectedSkill && compactProof === "returnSource")
                          yield* f.fs.writeFileString(
                            selectedSkill.packagePath + "/SKILL.md",
                            "Changed after compact terminal",
                          );
                        if (compactProof === "returnCancel") {
                          yield* Deferred.succeed(returnEntered, undefined);
                          yield* Effect.promise(
                            () =>
                              new Promise<void>((resolve) => {
                                if (signal.aborted) resolve();
                                else
                                  signal.addEventListener("abort", () => resolve(), { once: true });
                              }),
                          );
                        }
                      }
                      if (
                        compactProof === "cleanupReturn" &&
                        input.operation.operationKind === "compact"
                      ) {
                        // Exact first-run boundary: terminal is committed but run has not returned.
                        returnCleanup = (yield* journal.claimCleanup(snapshot.fence))._tag;
                        if (returnCleanup === "Claimed")
                          yield* journal.settleAfterJoined(snapshot.fence, {
                            receiptId: "compact-return-joined",
                            stage: "settled",
                            evidence: {
                              bindingId: f.binding.recordId,
                              worker: "joined",
                              transport: "drained",
                            },
                          });
                      }
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
          if (compactProof === "memoryAccounting" || compactProof === "memoryLiquidAccounting") {
            // Dispatch admission retains the original budget before the first model request.
            expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
            expect(yield* readRecordedUsage()).toMatchObject([
              {
                availability: "available",
                root: {
                  maximumTokens: 1000,
                  chargedTokens: 0,
                  reservedTokens: 0,
                  remainingTokens: 1000,
                },
              },
            ]);
          }
          if (memoryRoot && !hardRoot && compactProof !== "memoryRootMissingGrant") {
            yield* f.sql`INSERT INTO project_team_pi_subscription_grant
              (environment_id,project_id,root_task_id,model,route_id,maximum_tokens,maximum_duration_ms,deadline_at_ms)
              VALUES('environment',${projectId},${compactProof === "memoryRootDescendantGrant" ? f.binding.taskId : f.snapshot.intent.limits.rootTaskId},
              'gpt-6-luna','openai-subscription-luna',64000,300000,${f.root.snapshot.intent.limits.rootDeadlineAtMs})`;
          }
          const initialized = yield* runInstance.prepareOperation(
            {
              threadId,
              kind: "initialize",
              operationId: f.request.initializeOperationId,
              ...(returnSkillPlan ? { skillPlan: returnSkillPlan } : {}),
            },
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
          if (accountingProof && !subscriptionMemory && !memoryRoot) {
            expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
            expect(yield* readRecordedUsage()).toMatchObject([
              {
                availability: "available",
                root: {
                  maximumTokens: 1000,
                  chargedTokens: 0,
                  reservedTokens: 0,
                  remainingTokens: 1000,
                },
              },
            ]);
          }
          const assigned = yield* runInstance.prepareOperation(
            {
              threadId,
              kind: "prompt",
              operationId: f.request.assignmentOperationId,
              prompt: f.request.assignment,
              ...(returnSkillPlan ? { skillPlan: returnSkillPlan } : {}),
            },
            () => Effect.void,
          );
          const assignmentResult = yield* assigned.run.pipe(Effect.result);
          if (memoryRoot) {
            expect(memoryRootChecked).toBe(true);
            if (!memoryRootDenied) {
              expect(diagnostic).toBe("");
              expect(assignmentResult._tag).toBe("Success");
            }
            return;
          }
          if (subscriptionMemory) {
            expect(diagnostic).toBe("");
            expect(subscriptionMemoryChecked).toBe(true);
            expect(
              yield* f.sql`SELECT stop_reason,stopped_at_ms FROM project_team_pi_subscription_grant`,
            ).toEqual([
              {
                stop_reason: piUnknown ? "unknown-usage" : "threshold-reached",
                stopped_at_ms: expect.any(Number),
              },
            ]);
            if (piUnknown)
              expect(
                yield* f.sql`SELECT status,capacity_state,charged_input_tokens,charged_output_tokens
              FROM project_team_model_request WHERE request_lane='pi' AND request_id=2`,
              ).toEqual([
                {
                  status: "unknown",
                  capacity_state: "quarantine",
                  charged_input_tokens: 29_832,
                  charged_output_tokens: 64_000,
                },
              ]);
            return;
          }
          if (compactProof === "joinedNoMemory") {
            if (assignmentResult._tag !== "Success")
              return yield* Effect.die("No-memory prompt failed");
            const consumer = yield* makeProjectMemoryProcessingConsumer({
              environmentId: f.binding.environmentId,
              maximumConcurrentCalls: 1,
              maximumConcurrentModelCalls: 1,
              readConfiguration: Effect.succeed(undefined),
              assertAdmission: Effect.die("No-memory recovery must not assert current admission"),
              readCredential: () => Effect.die("No-memory recovery must not read credentials"),
              exchange: () => Effect.die("No-memory recovery must not exchange"),
              confirmModelTransportDrained: () =>
                Effect.die("No-memory recovery must not infer model drain"),
              companion: () => Effect.die("No-memory recovery must not start a companion"),
              observeCompanionCleanup: () => Effect.die("No-memory recovery must not wake cleanup"),
            }).pipe(Effect.provideService(ProjectWorkContentGuard, queryGuard));
            const recover = consumer.recoverJoinedOperation;
            if (!recover) return yield* Effect.die("No-memory recovery port missing");
            const rows = yield* f.sql<{
              ordinal: number;
              terminal: string;
            }>`SELECT operation_ordinal AS ordinal,terminal_json AS terminal FROM project_team_pi_operation WHERE operation_id=${f.request.assignmentOperationId}`;
            if (!rows[0]) return yield* Effect.die("No-memory operation missing");
            const identity = yield* decodeMemoryRecoveryIdentity({
              environmentId: f.binding.environmentId,
              projectId,
              taskId: f.binding.taskId,
              bindingId: f.binding.recordId,
              generation: f.binding.generation,
              providerInstanceId,
              threadId: f.binding.threadId,
              operationId: f.request.assignmentOperationId,
              workerId: assignmentResult.success.terminal.identity.workerId,
              ordinal: rows[0].ordinal,
            });
            expect(yield* f.sql`SELECT * FROM project_team_memory_query`).toEqual([]);
            expect(yield* f.sql`SELECT * FROM project_team_memory_job`).toEqual([]);
            for (const terminal of [
              null,
              json({
                ...assignmentResult.success.terminal,
                outcome: "quarantine",
                failureCode: "CALLBACK_DRAIN_UNKNOWN",
              }),
            ]) {
              yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=${terminal} WHERE operation_id=${identity.operationId}`;
              yield* recover(identity);
              expect(
                (yield* recover({ ...identity, workerId: "foreign" }).pipe(Effect.result))._tag,
              ).toBe("Failure");
              expect(
                (yield* recover({ ...identity, environmentId: "foreign" }).pipe(Effect.result))
                  ._tag,
              ).toBe("Failure");
              expect(
                (yield* f.sql.withTransaction(recover(identity)).pipe(Effect.result))._tag,
              ).toBe("Failure");
            }
            yield* f.sql`INSERT INTO project_team_memory_job(effect_id,environment_id,project_id,input_json,claim_generation,status,receipt_json,owner_json)
              VALUES('malformed-recovery',${identity.environmentId},${identity.projectId},'{}',0,'pending',NULL,'{"version":1,"operation":{}}')`;
            expect((yield* recover(identity).pipe(Effect.result))._tag).toBe("Failure");
            expect(yield* f.sql`SELECT status FROM project_team_memory_job`).toEqual([
              { status: "pending" },
            ]);
            return;
          }

          if (forwardProof) {
            if (!forwardDeniedObserved)
              return yield* Effect.die({
                diagnostic,
                memoryPipelineFailure,
                memoryExchanges,
                memoryBackendCalls,
              });
            expect({
              forwardChecks,
              forwardDeniedObserved,
              diagnostic,
              memoryExchanges,
              memoryBackendCalls,
            }).toMatchObject({
              forwardChecks: 1,
              forwardDeniedObserved: true,
            });
            expect(f.transports).toBe(0);
            return;
          }
          if (serverCurrent) expect(forwardChecks).toBe(1);
          if (queryDenied) {
            expect(assignmentResult._tag).toBe("Success");
            expect(yield* f.sql`SELECT * FROM project_team_memory_query`).toEqual([]);
            expect(memoryExchanges).toBe(0);
            expect(memoryBackendCalls).toBe(0);
            expect(runs).toBe(2);
            expect(f.transports).toBe(0);
            return;
          }
          if (queryAdmissionOnly) {
            if (
              queryRequest === undefined ||
              queryReceipt === undefined ||
              queryWorkerId === undefined
            )
              return yield* Effect.die("Executing operation did not retain its semantic query");
            // Admission alone cannot permit a successful terminal or a compact.
            // No embedding reservation or search has started at this checkpoint.
            expect(assignmentResult._tag).toBe("Failure");
            expect(
              yield* f.sql`SELECT status,embedding_json,search_json,result_json
              FROM project_team_memory_query`,
            ).toEqual([
              { status: "pending", embedding_json: null, search_json: null, result_json: null },
            ]);
            const retained = yield* f.sql`SELECT * FROM project_team_memory_query`;
            const charges = yield* f.sql`SELECT * FROM project_team_model_request`;
            const authorization = yield* Authorization.ProjectTeamAuthorization;
            const issued = yield* authorization.issueCredential({ providerInstanceId, threadId });
            if (issued === undefined)
              return yield* Effect.die("Query historical credential missing");
            const principal = {
              actor: {
                kind: "agent" as const,
                id: Authorization.managedActorId(issued.credential),
              },
              managed: issued.credential,
            };
            const gateway = yield* ProjectWorkGateway;
            expect(
              yield* gateway.write(
                queryRequest,
                principal.actor,
                { kind: "mcp", id: queryWorkerId },
                principal,
              ),
            ).toEqual(queryReceipt);
            expect(yield* f.sql`SELECT * FROM project_team_memory_query`).toEqual(retained);
            expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual(charges);
            expect(memoryExchanges).toBe(0);
            expect(memoryBackendCalls).toBe(0);
            expect(runs).toBe(2);
            expect(f.transports).toBe(0);
            return;
          }
          if (compactProof === "memorySourceJoinedRecovery") {
            if (!recoverMemory) return yield* Effect.die("Source recovery port missing");
            const jobs = yield* f.sql<{
              id: string;
              owner: string;
              generation: number;
            }>`SELECT effect_id AS id,owner_json AS owner,claim_generation AS generation FROM project_team_memory_job WHERE status='uncertain'`;
            const job = jobs[0];
            if (!job)
              return yield* Effect.die({ message: "Source recovery owner missing", diagnostic });
            const owner = yield* decodeMemoryLedgerOwner(job.owner);
            const identity = yield* decodeMemoryRecoveryIdentity(owner.operation);
            const operations = yield* f.sql<{
              terminal: string;
            }>`SELECT terminal_json AS terminal FROM project_team_pi_operation WHERE operation_id=${identity.operationId}`;
            const original = operations[0];
            if (!original?.terminal)
              return yield* Effect.die({ message: "Source recovery terminal missing", diagnostic });
            // Retain a crash-left recovery claim at its actual next generation.
            yield* f.sql`UPDATE project_team_memory_job SET status='claimed',claim_generation=${job.generation + 1} WHERE effect_id=${job.id}`;
            const charges =
              yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`;
            recoveryWakes.length = 0;
            yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=NULL WHERE operation_id=${identity.operationId}`;
            expect((yield* recoverMemory(identity).pipe(Effect.result))._tag).toBe("Failure");
            expect(
              yield* f.sql`SELECT status,claim_generation FROM project_team_memory_job`,
            ).toEqual([{ status: "claimed", claim_generation: job.generation + 1 }]);
            expect(recoveryWakes).toEqual([]);
            yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=${original.terminal} WHERE operation_id=${identity.operationId}`;
            yield* recoverMemory(identity);
            yield* recoverMemory(identity);
            expect(
              yield* f.sql`SELECT status,claim_generation,receipt_json FROM project_team_memory_job`,
            ).toEqual([
              { status: "uncertain", claim_generation: job.generation + 1, receipt_json: null },
            ]);
            expect(recoveryWakes).toEqual([job.id, job.id]);
            expect(
              yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`,
            ).toEqual(charges);
            return;
          }
          if (joinedRecovery) {
            if (!recoverMemory || !joinedTerminal)
              return yield* Effect.die({
                message: "Joined recovery port missing",
                diagnostic,
                hasPort: recoverMemory !== undefined,
                hasTerminal: joinedTerminal !== undefined,
              });
            const jobs = yield* f.sql<{
              id: string;
              owner: string;
              status: string;
              receipt: string;
              generation: number;
            }>`SELECT effect_id AS id,owner_json AS owner,status,receipt_json AS receipt,claim_generation AS generation FROM project_team_memory_job`;
            const queries = yield* f.sql<{
              id: string;
              status: string;
              result: string;
            }>`SELECT query_id AS id,status,result_json AS result FROM project_team_memory_query`;
            const job = jobs[0];
            const query = queries[0];
            if (!job || !query) return yield* Effect.die("Joined recovery rows missing");
            const owner = yield* decodeMemoryLedgerOwner(job.owner);
            const identity = yield* decodeMemoryRecoveryIdentity(owner.operation);
            const terminal = joinedTerminal;
            const modelRows =
              yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`;
            const operation = yield* f.sql<{
              terminal: string;
            }>`SELECT terminal_json AS terminal FROM project_team_pi_operation WHERE operation_id=${identity.operationId}`;
            const process = yield* f.sql<{
              drain: string;
            }>`SELECT drain_json AS drain FROM project_team_pi_process WHERE operation_id=${identity.operationId}`;
            if (!operation[0] || !process[0])
              return yield* Effect.die("Joined recovery receipts missing");
            // A crash can retain an unfinished stage flag after the joined terminal was persisted.
            yield* f.sql`UPDATE project_team_memory_query SET status='embedding' WHERE query_id=${query.id}`;
            const retainedQueries = yield* f.sql`SELECT * FROM project_team_memory_query`;
            const retainedJobs = yield* f.sql`SELECT * FROM project_team_memory_job`;
            recoveryWakes.length = 0;
            for (const changed of [
              null,
              json({ ...terminal, outcome: "quarantine" }),
              json({ ...terminal, failureCode: "CALLBACK_DRAIN_UNKNOWN" }),
              json({ ...terminal, identity: { ...terminal.identity, workerId: "foreign" } }),
            ]) {
              yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=${changed} WHERE operation_id=${identity.operationId}`;
              expect((yield* recoverMemory(identity).pipe(Effect.result))._tag).toBe("Failure");
              expect(yield* f.sql`SELECT * FROM project_team_memory_query`).toEqual(
                retainedQueries,
              );
              expect(yield* f.sql`SELECT * FROM project_team_memory_job`).toEqual(retainedJobs);
            }
            yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=${operation[0].terminal} WHERE operation_id=${identity.operationId}`;
            yield* f.sql`UPDATE project_team_pi_process SET drain_json=${json({ ...terminal.drain, invocation: "f".repeat(32) })} WHERE operation_id=${identity.operationId}`;
            expect((yield* recoverMemory(identity).pipe(Effect.result))._tag).toBe("Failure");
            yield* f.sql`UPDATE project_team_pi_process SET drain_json=${process[0].drain} WHERE operation_id=${identity.operationId}`;
            expect(
              (yield* recoverMemory({ ...identity, ordinal: identity.ordinal + 1 }).pipe(
                Effect.result,
              ))._tag,
            ).toBe("Failure");
            expect(
              (yield* f.sql.withTransaction(recoverMemory(identity)).pipe(Effect.result))._tag,
            ).toBe("Failure");
            expect(recoveryWakes).toEqual([]);
            yield* recoverMemory(identity);
            yield* recoverMemory(identity);
            expect(yield* f.sql`SELECT * FROM project_team_memory_job`).toEqual(retainedJobs);
            expect(yield* f.sql`SELECT status,result_json FROM project_team_memory_query`).toEqual([
              { status: "uncertain", result_json: null },
            ]);
            expect(recoveryWakes).toEqual([query.id, query.id]);
            expect(
              yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`,
            ).toEqual(modelRows);
            if (compactProof === "memoryQueryInterruptedRecovery") {
              if (!reconcileMemory) return yield* Effect.die("Interrupted query cleanup missing");
              expect((yield* reconcileMemory(query.id).pipe(Effect.result))._tag).toBe("Failure");
              expect(
                yield* f.sql`SELECT status,capacity_state FROM project_team_model_request WHERE json_extract(reservation_json,'$.effectId')=${query.id}`,
              ).toEqual([{ status: "unknown", capacity_state: "quarantine" }]);
              expect(yield* f.sql`SELECT result_json FROM project_team_memory_query`).toEqual([
                { result_json: null },
              ]);
            }
            return;
          }
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
          if (
            compactProof === "memoryPipeline" ||
            compactProof === "memoryQueryPipeline" ||
            compactProof === "memoryServerCurrent"
          ) {
            if (capturedMemoryOperation === undefined)
              return yield* Effect.die("Original memory bridge was not captured");
            expect(yield* capturedMemoryOperation.assertForward.pipe(Effect.result)).toMatchObject({
              _tag: "Failure",
              failure: { reason: "Original memory runtime cannot forward" },
            });
          }
          if (queryNoForward) {
            yield* Deferred.await(queryCleanupQueued);
            expect(delayedQueryCleanupRan).toBe(false);
            const queryRows = yield* f.sql<{
              status: string;
              result: string;
            }>`SELECT status,result_json AS result FROM project_team_memory_query`;
            expect(queryRows).toHaveLength(1);
            expect(queryRows[0]?.status).toBe("failed");
            expect(decodeRequiredJson(queryRows[0]?.result)).toMatchObject({
              outcome: "failed",
              hitIds: [],
            });
            const terminals = yield* f.sql<{
              terminal: string | null;
            }>`SELECT terminal_json AS terminal FROM project_team_pi_operation WHERE operation_id=${f.request.assignmentOperationId}`;
            expect(decodeRequiredJson(terminals[0]?.terminal)).toMatchObject({
              outcome: "success",
            });
            const charges =
              yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`;
            yield* Deferred.succeed(queryCleanupRelease, undefined);
            if (!delayedQueryCleanup)
              return yield* Effect.die("Delayed query cleanup worker missing");
            yield* Fiber.join(delayedQueryCleanup);
            expect(delayedQueryCleanupRan).toBe(true);
            expect(
              yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`,
            ).toEqual(charges);
            expect(
              yield* f.sql`SELECT status,result_json AS result FROM project_team_memory_query`,
            ).toEqual(queryRows);
          }
          yield* stage("assignment-observed");
          if (memoryProof) {
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
            if (pipelineProof) {
              expect(memoryExchanges).toBe(2);
              expect(memoryBackendCalls).toBe(3);
            } else if (accountingProof) {
              expect(runs).toBe(2);
              const failedContext = yield* f.reader.readRequired(snapshot);
              expectedContext = failedContext.text;
              expectedProvenance = NodeCrypto.createHash("sha256")
                .update(json(failedContext.provenance))
                .digest("hex");
              expectedRequestId = "recorded-usage-failed";
              const failedRequest = {
                threadId,
                kind: "compact" as const,
                requestId: MessageId.make(expectedRequestId),
              };
              const failedOperations = yield* makeProjectTeamPiOperations({
                environmentId: "environment",
              });
              // Reading the boundary requires the same durable caller reservation
              // as the production compaction entry point.
              yield* failedOperations.reserveCompaction(
                { providerInstanceId, threadId },
                failedRequest,
              );
              const failedBoundary = yield* failedOperations.readCompaction(
                { providerInstanceId, threadId },
                failedRequest,
              );
              failedUsageOperationId = failedBoundary.operationId;
              const failedPreparation = yield* runInstance
                .prepareOperation(
                  {
                    ...failedRequest,
                    operationId: failedUsageOperationId,
                  },
                  () => Effect.void,
                )
                .pipe(Effect.result);
              if (failedPreparation._tag === "Failure")
                yield* Effect.logError("controlled-accounting-prepare", {
                  failure: failedPreparation.failure,
                });
              expect(failedPreparation._tag).toBe("Success");
              if (failedPreparation._tag !== "Success") return yield* failedPreparation.failure;
              const failed = failedPreparation.success;
              expect((yield* failed.run.pipe(Effect.result))._tag).toBe("Failure");
              expect(
                yield* f.sql`SELECT status,capacity_state,charged_input_tokens,charged_output_tokens
                FROM project_team_model_request WHERE operation_id=${failedUsageOperationId}`,
              ).toEqual([
                {
                  status: "unknown",
                  capacity_state: "released",
                  charged_input_tokens: 100,
                  charged_output_tokens: 100,
                },
              ]);
              expect(
                yield* f.sql`SELECT json_extract(terminal_json,'$.outcome') AS outcome,
                json_array_length(terminal_json,'$.accountingReceipts') AS receipts
                FROM project_team_pi_operation WHERE operation_id=${failedUsageOperationId}`,
              ).toEqual([
                {
                  outcome: "failed",
                  receipts: 0,
                },
              ]);
              const settled = yield* journal.settleAfterJoined(snapshot.fence, {
                receiptId: "recorded-usage-joined",
                stage: "settled",
                evidence: { bindingId: f.binding.recordId, worker: "joined", transport: "drained" },
              });
              expect(settled.fence.stage).toBe("settled");
              const historical = yield* readCurrentState(f.sql, projectId);
              expect(
                historical.foundationRecords?.find(
                  (record) => record.recordId === f.binding.recordId,
                )?.status,
              ).toBe("settled");
              expect(
                historical.attempts.find((attempt) => attempt.attemptId === f.binding.attemptId)
                  ?.state,
              ).toBe("canceled");
              const beforeUsage =
                yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`;
              expect(yield* readRecordedUsage()).toMatchObject([
                {
                  availability: "available",
                  root: {
                    maximumTokens: 1000,
                    chargedTokens: 375,
                    reservedTokens: 0,
                    unknownChargedTokens: 241,
                    remainingTokens: 625,
                    heldCalls: 0,
                    quarantinedCalls: 0,
                  },
                  attempt: { maximumTokens: 1000, chargedTokens: 375, unknownChargedTokens: 241 },
                },
              ]);
              if (compactProof === "memorySharedRoot") {
                const parent = historical.foundationRecords?.find(
                  (record) =>
                    record.kind === "run-binding" && record.recordId === f.binding.parentRunId,
                );
                if (parent?.kind !== "run-binding")
                  return yield* Effect.die("Genuine original parent binding missing");
                expect(parent.taskId).not.toBe(f.binding.taskId);
                const parentUsage = yield* f.sql
                  .withTransaction(
                    readProjectTeamBindingAccountingInTransaction(f.sql, String(projectId), [
                      parent,
                    ]),
                  )
                  .pipe(
                    Effect.provideService(ServerEnvironmentIdentity, {
                      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
                    }),
                  );
                // The selected page contains only the parent; its root still includes
                // the charged child. Parent status is synthetic, not native proof.
                expect(parentUsage).toMatchObject([
                  {
                    availability: "available",
                    bindingId: parent.recordId,
                    root: {
                      taskId: parent.taskId,
                      chargedTokens: 375,
                      unknownChargedTokens: 241,
                      remainingTokens: 625,
                    },
                    attempt: { chargedTokens: 0, reservedTokens: 0, unknownChargedTokens: 0 },
                    operation: { chargedTokens: 0, reservedTokens: 0, unknownChargedTokens: 0 },
                  },
                ]);
              }
              const terminals = yield* f.sql<{ terminal: string }>`SELECT terminal_json AS terminal
                FROM project_team_pi_operation WHERE operation_id=${f.request.assignmentOperationId}`;
              const originalTerminal = terminals[0]?.terminal;
              if (terminals.length !== 1 || originalTerminal === undefined)
                return yield* Effect.die("Original accounted terminal missing");
              yield* f.sql`UPDATE project_team_pi_operation
                SET terminal_json=json_set(terminal_json,'$.accountingReceipts[0].reportedModel','foreign-reported-model')
                WHERE operation_id=${f.request.assignmentOperationId}`;
              expect(yield* readRecordedUsage()).toMatchObject([
                {
                  availability: "unavailable",
                  reason: "ledger-invalid",
                },
              ]);
              yield* f.sql`UPDATE project_team_pi_operation SET terminal_json=${originalTerminal}
                WHERE operation_id=${f.request.assignmentOperationId}`;
              const modelRows = yield* f.sql<{
                id: string;
                runId: string;
              }>`SELECT reservation_id AS id,run_id AS runId
                FROM project_team_model_request WHERE operation_id=${f.request.assignmentOperationId}
                AND request_lane='pi' ORDER BY request_id LIMIT 1`;
              const modelRow = modelRows[0];
              if (modelRow === undefined)
                return yield* Effect.die("Original recorded native reservation missing");
              yield* f.sql`UPDATE project_team_model_request SET run_id='foreign-usage-binding'
                WHERE reservation_id=${modelRow.id}`;
              expect(yield* readRecordedUsage()).toMatchObject([
                { availability: "unavailable", reason: "ledger-invalid" },
              ]);
              yield* f.sql`UPDATE project_team_model_request SET run_id=${modelRow.runId}
                WHERE reservation_id=${modelRow.id}`;
              yield* f.sql`UPDATE project_team_model_request SET capacity_state='legacy'
                WHERE reservation_id=${modelRow.id}`;
              expect(yield* readRecordedUsage()).toMatchObject([
                { availability: "unavailable", reason: "legacy-capacity" },
              ]);
              yield* f.sql`UPDATE project_team_model_request SET capacity_state='released'
                WHERE reservation_id=${modelRow.id}`;
              expect(
                yield* f.sql`SELECT * FROM project_team_model_request ORDER BY reservation_id`,
              ).toEqual(beforeUsage);
              expect(runs).toBe(3);
              expect(f.transports).toBe(0);
            } else if (queryCache) {
              if (
                queryRequest === undefined ||
                queryReceipt === undefined ||
                queryWorkerId === undefined
              )
                return yield* Effect.die("Completed semantic query was not retained");
              expect(
                yield* gateway.write(
                  queryRequest,
                  principal.actor,
                  { kind: "mcp", id: queryWorkerId },
                  principal,
                ),
              ).toEqual(queryReceipt);
              expect(memoryExchanges).toBe(3);
              expect(memoryBackendCalls).toBe(4);
              const cached = yield* f.reader.readRequired(snapshot);
              expect(cached.observations.provenance.queryId).toBeUndefined();
              expect(cached.text).not.toContain("completed semantic query");
              expect(memoryExchanges).toBe(3);
              expect(memoryBackendCalls).toBe(4);
            } else if (queryRecovery || queryNoForward || sharedDeliveryDenied) {
              if (
                queryRequest === undefined ||
                queryReceipt === undefined ||
                queryWorkerId === undefined
              )
                return yield* Effect.die("Failed semantic query was not retained");
              expect(
                yield* gateway.write(
                  queryRequest,
                  principal.actor,
                  { kind: "mcp", id: queryWorkerId },
                  principal,
                ),
              ).toEqual(queryReceipt);
              expect(memoryExchanges).toBe(queryNoForward ? 2 : 3);
              expect(memoryBackendCalls).toBe(
                queryNoForward ||
                  sharedBeforeSearchDenied ||
                  compactProof === "memoryQueryModelUnknown" ||
                  startFailure
                  ? 3
                  : 4,
              );
              expect(
                (yield* f.reader.readRequired(snapshot)).observations.provenance.queryId,
              ).toBeUndefined();
            } else if (sourceFailure) {
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
            } else if (cleanupProof) {
              expect(memoryExchanges).toBe(0);
              expect(memoryBackendCalls).toBe(humanRetraction ? 2 : 1);
              if (humanRetraction) {
                // A legal, immutable journal insert simulates a late index intent
                // at the deleted generation; it confers no new owner authority.
                yield* f.sql`INSERT INTO project_team_memory_job
                  (effect_id,environment_id,project_id,input_json,claim_generation,status,receipt_json)
                  SELECT 'live-unfenced-index',environment_id,project_id,
                    json_set(input_json,'$.effect.effectId','live-unfenced-index',
                      '$.effect.recordId','live-unfenced-index',
                      '$.effect.generation',(SELECT json_extract(payload_json,'$.generation') FROM project_team_memory_source
                        WHERE record_id=json_extract(input_json,'$.source.recordId')),
                      '$.source.generation',(SELECT json_extract(payload_json,'$.generation') FROM project_team_memory_source
                        WHERE record_id=json_extract(input_json,'$.source.recordId')),
                      '$.extraction.sourceGeneration',(SELECT json_extract(payload_json,'$.generation') FROM project_team_memory_source
                        WHERE record_id=json_extract(input_json,'$.source.recordId'))),0,'pending',NULL
                  FROM project_team_memory_job WHERE project_id=${projectId}
                    AND json_extract(input_json,'$.effect.effectKind')='memory-index' ORDER BY effect_id LIMIT 1`;
                expect(
                  yield* f.sql`SELECT effect_id FROM project_team_memory_job WHERE effect_id='live-unfenced-index'`,
                ).toEqual([{ effect_id: "live-unfenced-index" }]);
                expect(yield* deleteRetainedProject().pipe(Effect.result)).toMatchObject({
                  _tag: "Failure",
                  failure: { _tag: "ProjectLifecycleError", reason: "memory-cleanup-required" },
                });
                expect(
                  yield* f.sql`SELECT deleted_at FROM projection_projects WHERE project_id=${projectId}`,
                ).toEqual([{ deleted_at: null }]);
                yield* f.sql`DELETE FROM project_team_memory_job WHERE effect_id='live-unfenced-index'`;
                const cleanedState = yield* readCurrentState(f.sql, projectId);
                const deletedSource = cleanedState.foundationRecords?.find(
                  (record) => record.kind === "memory-source" && record.status === "retracted",
                );
                if (deletedSource?.kind !== "memory-source")
                  return yield* Effect.die("Completed cleanup source missing");
                const retainedTasks = yield* f.sql`SELECT * FROM project_work_tasks
                  WHERE project_id=${projectId}`;
                expect(retainedTasks.length).toBeGreaterThan(0);
                // These disposable journal rows have no extraction authority.
                // Each tuple must still be fenced by the exact source deletion.
                for (const tuple of [
                  {
                    name: "equal-generation",
                    revision: deletedSource.sourceRevision,
                    generation: deletedSource.generation,
                  },
                  {
                    name: "newer-generation",
                    revision: deletedSource.sourceRevision,
                    generation: deletedSource.generation + 1,
                  },
                  {
                    name: "different-revision",
                    revision: deletedSource.sourceRevision + 1,
                    generation: 0,
                  },
                ]) {
                  const orphanExtractionId = `live-unfenced-source-manifest-${tuple.name}`;
                  expect(
                    yield* f.sql`SELECT extraction_id FROM project_team_memory_manifest
                    WHERE extraction_id=${orphanExtractionId}`,
                  ).toEqual([]);
                  yield* f.sql`INSERT INTO project_team_memory_manifest
                  (extraction_id,environment_id,project_id,source_id,source_revision,source_generation,manifest_json)
                  VALUES (${orphanExtractionId},'environment',${projectId},${deletedSource.recordId},
                    ${tuple.revision},${tuple.generation},'{}')`;
                  expect(
                    yield* f.sql`SELECT extraction_id,source_id,source_revision,source_generation
                    FROM project_team_memory_manifest WHERE extraction_id=${orphanExtractionId}`,
                  ).toEqual([
                    {
                      extraction_id: orphanExtractionId,
                      source_id: deletedSource.recordId,
                      source_revision: tuple.revision,
                      source_generation: tuple.generation,
                    },
                  ]);
                  expect(
                    yield* deleteRetainedProject().pipe(Effect.result),
                    tuple.name,
                  ).toMatchObject({
                    _tag: "Failure",
                    failure: { _tag: "ProjectLifecycleError", reason: "memory-cleanup-required" },
                  });
                  expect(
                    yield* f.sql`SELECT deleted_at FROM projection_projects WHERE project_id=${projectId}`,
                  ).toEqual([{ deleted_at: null }]);
                  expect(
                    yield* f.sql`SELECT * FROM project_work_tasks WHERE project_id=${projectId}`,
                  ).toEqual(retainedTasks);
                  expect(memoryExchanges).toBe(0);
                  expect(memoryBackendCalls).toBe(2);
                  yield* f.sql`DELETE FROM project_team_memory_manifest WHERE extraction_id=${orphanExtractionId}`;
                }
                const completedOwners = yield* f.sql<{ owner: string }>`SELECT owner_json AS owner
                  FROM project_team_memory_job WHERE project_id=${projectId} AND status='settled'
                    AND owner_json IS NOT NULL AND json_extract(input_json,'$.effect.effectKind')='memory-delete'
                  ORDER BY effect_id LIMIT 1`;
                const completedOwnerJson = completedOwners[0]?.owner;
                if (completedOwnerJson === undefined)
                  return yield* Effect.die("Completed cleanup owner missing");
                const completedOwner = yield* decodeMemoryLedgerOwner(completedOwnerJson);
                const originalOperation = completedOwner.operation;
                for (const drift of ["binding", "attempt"] as const) {
                  const orphanReservationId = `live-foreign-${drift}-memory-reservation`;
                  const physicalBinding =
                    drift === "binding"
                      ? `${originalOperation.bindingId}-foreign`
                      : originalOperation.bindingId;
                  const physicalAttempt =
                    drift === "attempt"
                      ? `${originalOperation.attemptId}-foreign`
                      : originalOperation.attemptId;
                  const reservation = {
                    version: 1,
                    lane: "memory",
                    scope: "0".repeat(64),
                    effectId: completedOwner.selection.effectId,
                    ownerSha256: projectMemoryHash(completedOwner),
                    phase: "extract",
                    workerId: originalOperation.workerId,
                    generation: originalOperation.generation,
                    operationId: originalOperation.operationId,
                    requestId: 1,
                    routeId: "controlled-orphan-memory-route",
                    provider: "command-code",
                    model: "inclusionai/ling-3.1-flash:free",
                    maxInputTokens: 1,
                    maxOutputTokens: 1,
                    callCount: 1,
                    deadlineAtMs: Math.min(
                      originalOperation.rootDeadlineAtMs,
                      originalOperation.attemptDeadlineAtMs,
                      originalOperation.operationDeadlineAtMs,
                      originalOperation.leaseDeadlineAtMs,
                    ),
                  };
                  const settlement = decodeQueryRecoverySettlement(
                    json({
                      ...reservation,
                      reservationId: orphanReservationId,
                      outcome: "failed",
                      chargedInputTokens: 1,
                      chargedOutputTokens: 1,
                      transportDrained: true,
                    }),
                  );
                  expect(
                    yield* f.sql`SELECT reservation_id FROM project_team_model_request
                  WHERE reservation_id=${orphanReservationId}`,
                  ).toEqual([]);
                  // This disposable released row is not an actual model request.
                  // Matching worker/operation fields cannot cover foreign binding or attempt.
                  yield* f.sql`INSERT INTO project_team_model_request
                  (reservation_id,environment_id,project_id,root_task_id,run_id,attempt_id,worker_id,
                   generation,operation_id,request_id,request_lane,request_scope,route_id,provider,model,
                   environment_slot,model_slot,maximum_input_tokens,maximum_output_tokens,deadline_at_ms,
                   status,charged_input_tokens,charged_output_tokens,accounting_receipt_id,
                   reservation_json,settlement_json,capacity_state)
                  VALUES (${orphanReservationId},${originalOperation.environmentId},${projectId},
                    ${originalOperation.rootTaskId},${physicalBinding},${physicalAttempt},
                    ${originalOperation.workerId},${originalOperation.generation},${originalOperation.operationId},
                    1,'memory',${reservation.scope},${reservation.routeId},${reservation.provider},${reservation.model},
                    0,0,1,1,${reservation.deadlineAtMs},'failed',1,1,'controlled-orphan-memory-accounting',
                    ${json(reservation)},${json(settlement)},'released')`;
                  const orphanRow = yield* f.sql`SELECT * FROM project_team_model_request
                  WHERE reservation_id=${orphanReservationId}`;
                  expect(orphanRow).toHaveLength(1);
                  expect(orphanRow[0]).toMatchObject({
                    run_id: physicalBinding,
                    attempt_id: physicalAttempt,
                    worker_id: originalOperation.workerId,
                    generation: originalOperation.generation,
                    operation_id: originalOperation.operationId,
                    root_task_id: originalOperation.rootTaskId,
                    request_lane: "memory",
                    capacity_state: "released",
                  });
                  expect(yield* deleteRetainedProject().pipe(Effect.result), drift).toMatchObject({
                    _tag: "Failure",
                    failure: { _tag: "ProjectLifecycleError", reason: "memory-cleanup-required" },
                  });
                  expect(
                    yield* f.sql`SELECT deleted_at FROM projection_projects
                  WHERE project_id=${projectId}`,
                  ).toEqual([{ deleted_at: null }]);
                  expect(
                    yield* f.sql`SELECT * FROM project_work_tasks
                  WHERE project_id=${projectId}`,
                  ).toEqual(retainedTasks);
                  expect(
                    yield* f.sql`SELECT * FROM project_team_model_request
                  WHERE reservation_id=${orphanReservationId}`,
                  ).toEqual(orphanRow);
                  expect(memoryExchanges).toBe(0);
                  expect(memoryBackendCalls).toBe(2);
                  yield* f.sql`DELETE FROM project_team_model_request
                  WHERE reservation_id=${orphanReservationId}`;
                }
                const journals =
                  yield* f.sql`SELECT * FROM project_team_memory_job ORDER BY effect_id`;
                const deleted = yield* deleteRetainedProject();
                expect(deleted.project.state).toBe("tombstoned");
                expect(deleted.filesDeleted).toBe(false);
                expect(
                  yield* f.sql`SELECT task_id FROM project_work_tasks WHERE project_id=${projectId}`,
                ).toEqual([]);
                expect(
                  yield* f.sql`SELECT * FROM project_team_memory_job ORDER BY effect_id`,
                ).toEqual(journals);
                expect(
                  yield* f.sql.withTransaction(
                    readProjectMemoryProjectionSyncInTransaction(
                      f.sql,
                      String(projectId),
                      "environment",
                    ),
                  ),
                ).toBe(true);
                expect(memoryExchanges).toBe(0);
                expect(memoryBackendCalls).toBe(2);
                expect(yield* deleteRetainedProject()).toEqual(deleted);
              }
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
            ...(returnSkillPlan ? { skillPlan: returnSkillPlan } : {}),
          };
          yield* operations.reserveCompaction({ providerInstanceId, threadId }, supplied);
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
              : runInstance;
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
          const compactResult = yield* Effect.gen(function* () {
            if (compactProof !== "returnCancel") return yield* compact.run.pipe(Effect.result);
            const running = yield* compact.run.pipe(Effect.result, Effect.forkChild);
            yield* Deferred.await(returnEntered);
            yield* runInstance.requestStop(threadId);
            return yield* Fiber.join(running);
          });
          if (returnProof) {
            expect(finalFenceEntered).toBe(compactProof?.endsWith("AfterWrite"));
            expect(compactResult._tag).toBe("Failure");
            expect(
              yield* f.sql`SELECT status,json_extract(terminal_json,'$.outcome') AS outcome FROM project_team_pi_operation WHERE operation_kind='compact'`,
            ).toEqual([{ status: "running", outcome: "success" }]);
            expect(yield* f.sql`SELECT status FROM project_team_compact_caller`).toEqual([
              { status: "consumed" },
            ]);
            expect(yield* f.sql`SELECT cleanup_claim_revision FROM project_team_dispatch`).toEqual([
              { cleanup_claim_revision: null },
            ]);
            const charges = yield* f.sql`SELECT * FROM project_team_model_request`;
            const allocations = f.allocations;
            const restarted = yield* (yield* makePiManagedRuntimeLive(f.options)).forInstance({
              instanceId: providerInstanceId,
              enabled: true,
              configuration: {},
            });
            expect(
              (yield* restarted.prepareOperation(request, () => Effect.void).pipe(Effect.result))
                ._tag,
            ).toBe("Failure");
            expect(runs).toBe(3);
            expect(f.allocations).toBe(allocations);
            expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual(charges);
            expect(f.transports).toBe(0);
            return;
          }
          expect({
            result: compactResult,
            constructed,
            runEntries,
            runs,
            diagnostic,
            returnBoundaryCause,
            returnCleanup,
          }).toMatchObject({
            diagnostic: "",
            returnBoundaryCause: "",
            ...(compactProof === "cleanupReturn" ? { returnCleanup: "WaitingForCompact" } : {}),
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
          const replay = yield* runInstance.prepareOperation(request, () => Effect.void);
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
          if (compactProof === "cleanupReturn") {
            expect((yield* journal.claimCleanup(snapshot.fence))._tag).toBe("Claimed");
            yield* journal.settleAfterJoined(snapshot.fence, {
              receiptId: "first-return-complete-joined",
              stage: "settled",
              evidence: { bindingId: f.binding.recordId, worker: "joined", transport: "drained" },
            });
            expect(
              (yield* runInstance.prepareOperation(request, () => Effect.void).pipe(Effect.result))
                ._tag,
            ).toBe("Failure");
            expect(runs).toBe(3);
            expect(f.allocations).toBe(allocations);
            return;
          }
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
            yield* operations.reserveCompaction({ providerInstanceId, threadId }, nextSupplied);
            const nextBoundary = yield* operations.readCompaction(
              { providerInstanceId, threadId },
              nextSupplied,
            );
            const next = yield* runInstance.prepareOperation(
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
          yield* operations.reserveCompaction(
            { providerInstanceId, threadId },
            {
              threadId,
              requestId: MessageId.make("live-compact-context-race"),
            },
          );
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
            (yield* runInstance
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
        compactProof?.startsWith("memoryServerQuery") === true ||
          compactProof === "memoryHumanRetraction" ||
          compactProof === "memoryCompanionDelete" ||
          compactProof?.startsWith("memoryQueryShared") === true ||
          compactProof === "memoryCompanionSharedQuery",
      ).pipe(Effect.provide(selectedRuntimeLayer)),
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
            const snapshot = kind === "prompt" ? yield* initializeRequiredContext(f) : f.snapshot;
            const current = yield* f.reader.readRequired(snapshot);
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
                ? {
                    threadId: f.binding.threadId,
                    kind,
                    operationId: f.request.initializeOperationId,
                  }
                : {
                    threadId: f.binding.threadId,
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
            ).toHaveLength(kind === "prompt" ? 1 : 0);
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
  it.effect(
    `required context transfer rejects ${mode === "prompt-budget" ? "original-assignment context overflow at initialization" : mode} before managed allocation`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* requiredTransferFixture(
            false,
            false,
            undefined,
            false,
            "project",
            mode === "prompt-budget" ? "é".repeat(32769) : undefined,
          );
          const addQuestions = Effect.fn("requiredTransferFixture.addQuestions")(function* (
            count: number,
          ) {
            const state = yield* readCurrentState(f.sql, projectId);
            const gate = state.foundationRecords?.find(
              (r) => r.kind === "gate" && r.gate === "plan",
            );
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
          const retainedBefore =
            mode === "prompt-budget"
              ? yield* f.sql`SELECT intent_json FROM project_team_dispatch`
              : undefined;
          const budgetBefore =
            mode === "prompt-budget"
              ? yield* f.sql`SELECT * FROM project_team_model_budget`
              : undefined;
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
              ? {
                  revalidateRuntime: addQuestions(1).pipe(Effect.mapError(controlledCallbackError)),
                }
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
                  kind: "initialize",
                  operationId: f.request.initializeOperationId,
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
          if (mode === "prompt-budget") {
            expect(f.allocations).toBe(0);
            expect(yield* f.sql`SELECT intent_json FROM project_team_dispatch`).toEqual(
              retainedBefore,
            );
            expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toEqual(budgetBefore);
          }
          expect(
            yield* f.sql`SELECT operation_id FROM project_team_pi_operation WHERE operation_id=${f.request.initializeOperationId}`,
          ).toEqual([]);
        }),
      ),
  );

for (const change of [
  "tokens",
  "deadline",
  "expired",
  "paused",
  "canceled",
  "revoked",
  "quarantined",
  "partial-setup",
  "unfinished-setup",
  "source-config",
  "foreign-root",
  "child-grant",
  "parent-spec",
  "parent-plan",
  "missing-source",
] as const)
  it.effect(`human child root budget refuses ${change} before allocation`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* requiredReviewTransferFixture();
        const state = yield* readCurrentState(f.sql, projectId);
        const root = state.foundationRecords?.find(
          (record) => record.kind === "run-binding" && record.recordId === f.root.bindingId,
        );
        const membership = state.foundationRecords?.find(
          (record) => record.kind === "task-membership" && record.taskId === f.root.taskId,
        );
        const role = state.foundationRecords?.find(
          (record) =>
            record.kind === "role-revision" &&
            record.recordId === (root?.kind === "run-binding" ? root.roleRevisionId : undefined),
        );
        const gate = state.foundationRecords?.find(
          (record) =>
            record.kind === "gate" &&
            (change === "child-grant"
              ? record.recordId === f.binding.authorizationGateId
              : record.taskId === f.root.taskId &&
                record.gate === (change === "parent-plan" ? "plan" : "specification")),
        );
        if (
          root?.kind !== "run-binding" ||
          membership?.kind !== "task-membership" ||
          role?.kind !== "role-revision" ||
          gate?.kind !== "gate"
        )
          return yield* Effect.die("Missing original human child budget fixture owner");
        if (change === "tokens")
          yield* f.sql`UPDATE project_team_model_budget SET maximum_tokens=maximum_tokens+1`;
        if (change === "deadline")
          yield* f.sql`UPDATE project_team_model_budget SET deadline_at_ms=deadline_at_ms+1`;
        if (change === "expired")
          yield* TestClock.setTime(f.root.snapshot.intent.limits.rootDeadlineAtMs);
        if (change === "paused" || change === "canceled")
          yield* restoreHistoricalBinding({
            ...membership,
            revision: membership.revision + 1,
            controlState: change === "paused" ? "paused" : "canceled",
          });
        if (change === "revoked" || change === "quarantined")
          yield* restoreHistoricalBinding({ ...root, revision: root.revision + 1, status: change });
        if (change === "partial-setup")
          yield* f.sql`UPDATE project_team_dispatch SET stage='reserved' WHERE dispatch_id=${f.root.snapshot.fence.dispatchId}`;
        if (change === "unfinished-setup")
          yield* restoreHistoricalBinding({
            recordId: "required-root-setup",
            projectId,
            revision: 0,
            generation: 0,
            updatedAt: at,
            kind: "effect",
            status: "uncertain",
            effectId: "required-root-setup",
            effectKind: "setup",
            runId: root.recordId,
            targetId: root.recordId,
            payload: { recordIds: [root.recordId], expectedRevision: 0 },
            claimGeneration: 0,
            availableAt: at,
          });
        if (change === "foreign-root")
          yield* restoreHistoricalBinding({
            ...root,
            revision: root.revision + 1,
            environmentId: EnvironmentId.make("foreign-environment"),
          });
        if (change === "source-config")
          yield* restoreHistoricalBinding({
            ...role,
            revision: role.revision + 1,
            instructions: role.instructions + " changed",
          });
        if (change === "child-grant" || change === "parent-spec" || change === "parent-plan")
          yield* restoreHistoricalBinding({
            ...gate,
            revision: gate.revision + 1,
            status: "rejected",
          });
        if (change === "missing-source")
          yield* f.sql`DELETE FROM project_team_workspace_receipt WHERE dispatch_id=${f.root.snapshot.fence.dispatchId}`;
        const budget =
          yield* f.sql`SELECT environment_id,project_id,root_task_id,maximum_tokens,deadline_at_ms FROM project_team_model_budget`;
        const intents =
          yield* f.sql`SELECT dispatch_id,intent_json FROM project_team_dispatch ORDER BY dispatch_id`;
        let allocations = 0;
        const original = ManagedProcess.preallocatePiManagedProcess;
        const spy = vi
          .spyOn(ManagedProcess, "preallocatePiManagedProcess")
          .mockImplementation((launch) => {
            allocations++;
            return original(launch);
          });
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        const result = yield* f.instance
          .prepareOperation(
            {
              threadId: f.binding.threadId,
              kind: "initialize",
              operationId: f.request.initializeOperationId,
            },
            () => Effect.void,
          )
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(allocations).toBe(0);
        expect(f.allocations).toBe(0);
        expect(f.transports).toBe(0);
        expect(
          yield* f.sql`SELECT operation_id FROM project_team_pi_operation WHERE binding_id=${f.binding.recordId}`,
        ).toEqual([]);
        expect(
          yield* f.sql`SELECT reservation_id FROM project_team_model_request WHERE run_id=${f.binding.recordId}`,
        ).toEqual([]);
        expect(
          yield* f.sql`SELECT environment_id,project_id,root_task_id,maximum_tokens,deadline_at_ms FROM project_team_model_budget`,
        ).toEqual(budget);
        expect(
          yield* f.sql`SELECT dispatch_id,intent_json FROM project_team_dispatch ORDER BY dispatch_id`,
        ).toEqual(intents);
      }),
    ),
  );

const subscriptionRuntimeProfile: RuntimeFixtureProfile = {
  ...basicRuntimeProfile,
  model: "gpt-6-luna",
  maximumTokens: 64_000,
  durationMs: 300_000,
  maxInputTokens: 16_384,
  maxOutputTokens: 2_048,
};
const subscriptionSelection = (
  f: Pick<Effect.Success<ReturnType<typeof dispatchedRuntimeFixture>>, "binding" | "snapshot">,
): ProjectTeamPiSubscriptionTestSelection => ({
  projectId: f.binding.projectId,
  rootTaskId: f.snapshot.intent.limits.rootTaskId,
  model: "gpt-6-luna",
  maximumTokens: 64_000,
  maximumDurationMs: 300_000,
});

const decodeConcurrentAllocation = Schema.decodeSync(
  Schema.fromJsonString(ManagedProcess.PiManagedProcessAllocationSchema),
);
const isConcurrentUserMessage = Schema.is(
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
  }),
);
const decodeConcurrentOwner = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      unit: Schema.String,
      invocation: Schema.String,
      pid: Schema.Int,
      cgroup: Schema.String,
      memoryBytes: Schema.Int,
    }),
  ),
);

// Separate opt-in gate: no held SDK declarations or ordinary runtime checks enable this case.
describe.runIf(process.env.PI_MANAGED_RUNTIME_NATIVE_CONCURRENT === "1")(
  "two native subscription prompt groups under one approved root",
  () => {
    for (const omitSiblingRegistration of [false, true])
      it.live(
        omitSiblingRegistration
          ? "negative control leaves the unregistered native sibling live until exact owner teardown"
          : "production factory HTTP 503 cancels and joins both concurrent native prompt groups",
        () =>
          scoped(
            Effect.gen(function* () {
              const distributionDirectory = process.env.PI_MANAGED_RUNTIME_INITIALIZATION_DIST;
              const evidenceRoot = process.env.PI_MANAGED_RUNTIME_TEST_EVIDENCE;
              if (!distributionDirectory || !evidenceRoot)
                return yield* Effect.die(
                  "Owned SDK 0.99.1 distribution and native evidence are required",
                );
              const fs = yield* FileSystem.FileSystem;
              const evidence = evidenceRoot + (omitSiblingRegistration ? "/negative" : "/positive");
              yield* fs.makeDirectory(evidence, { recursive: true, mode: 0o700 });
              const ownedScratchDirectory = distributionDirectory + "-owned-runtime";
              yield* fs.makeDirectory(ownedScratchDirectory, { recursive: true, mode: 0o700 });
              const settings = yield* ServerSettings.ServerSettingsService;
              yield* settings.updateSettings({ projectTeamExecutionEnabled: true });
              const approvedAtMs = yield* Clock.currentTimeMillis;
              const f = yield* requiredTransferFixture(
                false,
                true,
                "planning",
                false,
                "none",
                "Draft the approved bounded child plan",
                {
                  ...subscriptionRuntimeProfile,
                  originalClockAtMs: approvedAtMs,
                  ownedScratchDirectory,
                  nativePlanningSiblings: true,
                },
              );
              if (!("siblings" in f))
                return yield* Effect.die("Expected planning sibling fixture, not a review fixture");
              expect(f.siblings).toHaveLength(2);
              const [first, second] = f.siblings;
              if (!first || !second) return yield* Effect.die("Missing genuine sibling claims");
              expect(first.binding.taskId).not.toBe(second.binding.taskId);
              expect(first.binding.threadId).not.toBe(second.binding.threadId);
              expect(first.binding.worktree).not.toBe(second.binding.worktree);
              const originalDeadlineAtMs = f.root.snapshot.intent.limits.rootDeadlineAtMs;
              const originalRoot = f.root.snapshot.intent;
              expect(originalRoot.limits.maximumTokens).toBe(64_000);
              expect(originalDeadlineAtMs).toBeGreaterThanOrEqual(approvedAtMs + 300_000);
              for (const child of f.siblings) {
                expect(child.binding.parentRunId).toBe(f.root.binding.recordId);
                expect(child.snapshot.intent.limits.rootTaskId).toBe(f.root.binding.taskId);
                expect(child.snapshot.intent.limits.rootDeadlineAtMs).toBe(originalDeadlineAtMs);
                expect(child.snapshot.intent.limits.deadlineAtMs).toBeLessThanOrEqual(
                  originalDeadlineAtMs,
                );
                expect(child.binding.configuration.maxDurationMs).toBe(60_000);
              }
              const access = `header.${Buffer.from(
                json({
                  exp: Math.ceil(originalDeadlineAtMs / 1000) + 60,
                  "https://api.openai.com/auth": {
                    chatgpt_account_id: "synthetic-concurrent-account",
                  },
                }),
              ).toString("base64url")}.signature`;
              yield* fs.writeFileString(
                f.options.agentDirectory + "/auth.json",
                json({
                  "openai-codex": {
                    type: "oauth",
                    access,
                    expires: originalDeadlineAtMs + 60_000,
                    accountId: "synthetic-concurrent-account",
                  },
                }),
              );
              const captured: Array<{
                unit: string;
                kind: string;
                pid: number;
                startTime: string;
              }> = [];
              const capture = Effect.fn("nativeConcurrent.capture")(function* (
                unit: string,
                kind: string,
                pid: number,
              ) {
                const stat = yield* fs.readFileString(`/proc/${pid}/stat`);
                const startTime = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
                if (!startTime || !/^\d+$/.test(startTime))
                  return yield* Effect.die("Native PID start absent");
                captured.push({ unit, kind, pid, startTime });
                yield* fs.writeFileString(evidence + "/captured-pids.json", json(captured));
              });
              const originalSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
              const observed = ChildProcessSpawner.make((command) => {
                if (
                  command._tag !== "StandardCommand" ||
                  command.command !== "/usr/bin/systemd-run"
                )
                  return originalSpawner.spawn(command);
                const unit = command.args.find((arg) => arg.startsWith("--unit="))?.slice(7);
                if (!unit) return Effect.die("Native launcher unit absent");
                const args = [...command.args];
                const helperIndex = args.indexOf("/usr/bin/python3");
                if (helperIndex < 0) return Effect.die("Native owner helper absent");
                // Same tighter envelope as the retained activation smoke; no allocation/deadline change.
                args.splice(
                  helperIndex,
                  0,
                  "-p",
                  "TasksMax=128",
                  "-p",
                  "CPUQuota=200%",
                  "-p",
                  "AllowedCPUs=0,1",
                );
                let pending = Buffer.alloc(0);
                let transcript = Buffer.alloc(0);
                return originalSpawner
                  .spawn(ChildProcess.make(command.command, args, command.options))
                  .pipe(
                    Effect.tap((handle) => capture(unit, "launcher", Number(handle.pid))),
                    Effect.tap((handle) =>
                      fs.writeFileString(
                        evidence + "/" + unit + ".launch.json",
                        json({ command: command.command, args, launcherPid: Number(handle.pid) }),
                      ),
                    ),
                    Effect.map((handle) =>
                      ChildProcessSpawner.makeHandle({
                        ...handle,
                        stdout: handle.stdout.pipe(
                          Stream.tap((chunk) =>
                            Effect.gen(function* () {
                              transcript = Buffer.concat([transcript, chunk]);
                              if (transcript.byteLength > 1048576)
                                return yield* Effect.die("Native transcript bound exceeded");
                              yield* fs.writeFile(
                                evidence + "/" + unit + ".frames.jsonl",
                                transcript,
                              );
                              pending = Buffer.concat([pending, chunk]);
                              for (;;) {
                                const newline = pending.indexOf(10);
                                if (newline < 0) break;
                                if (newline > 65536)
                                  return yield* Effect.die("Native ownership frame bound exceeded");
                                const frame = yield* decodeActivationFrame(
                                  pending.subarray(0, newline).toString("utf8"),
                                ).pipe(Effect.orDie);
                                pending = pending.subarray(newline + 1);
                                if (frame.type === "owner" || frame.type === "started") {
                                  if (frame.pid === undefined)
                                    return yield* Effect.die("Native ownership PID absent");
                                  yield* capture(unit, frame.type, frame.pid);
                                }
                              }
                              if (pending.byteLength > 65536)
                                return yield* Effect.die("Native ownership frame bound exceeded");
                            }),
                          ),
                        ),
                      }),
                    ),
                  );
              });
              const arrived = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
              const failFirst = Promise.withResolvers<void>();
              const transportAborted = [
                Promise.withResolvers<void>(),
                Promise.withResolvers<void>(),
              ];
              const signals: Array<AbortSignal | undefined> = [];
              const requests: Array<unknown> = [];
              let calls = 0;
              const transport: typeof globalThis.fetch = async (_endpoint, init) => {
                if (typeof init?.body !== "string" || !init.signal)
                  throw Error("Original broker request absent");
                expect(String(_endpoint)).toBe("https://chatgpt.com/backend-api/codex/responses");
                expect(init.headers).toMatchObject({
                  Authorization: `Bearer ${access}`,
                  "chatgpt-account-id": "synthetic-concurrent-account",
                });
                calls++;
                if (calls > 2)
                  throw Error("Unexpected model transport; external calls are forbidden");
                const body = decodeNativeJsonEvidence(init.body);
                const index = f.siblings.findIndex((child) =>
                  init.body!.toString().includes(child.request.assignment),
                );
                if (index < 0 || signals[index])
                  throw Error("Foreign or duplicate native model request");
                expect(Buffer.byteLength(init.body)).toBeLessThanOrEqual(16_384);
                const headers = new Headers(init.headers);
                expect(headers.get("user-agent")).toMatch(/^pi \(/);
                expect(body.prompt_cache_key).toEqual(expect.any(String));
                expect(headers.get("session-id")).toBe(body.prompt_cache_key);
                expect(headers.get("x-client-request-id")).toBe(body.prompt_cache_key);
                expect(body).toMatchObject({
                  model: "gpt-6-luna",
                  stream: true,
                  store: false,
                  reasoning: { effort: "high" },
                  service_tier: "default",
                });
                signals[index] = init.signal;
                requests[index] = body;
                const signal = init.signal;
                signal.addEventListener("abort", () => transportAborted[index]!.resolve(), {
                  once: true,
                });
                arrived[index]!.resolve();
                if (index === 0) {
                  await failFirst.promise;
                  return new Response("controlled unknown accounting", { status: 503 });
                }
                return await new Promise<Response>((_resolve, reject) => {
                  const abort = () =>
                    reject(signal.reason ?? Error("Captured sibling transport canceled"));
                  if (signal.aborted) abort();
                  else signal.addEventListener("abort", abort, { once: true });
                });
              };
              const constructed: Array<Parameters<typeof RuntimeLive.makePiManagedRuntimeLive>[0]> =
                [];
              const originalLive = RuntimeLive.makePiManagedRuntimeLive;
              const factorySpy = vi
                .spyOn(RuntimeLive, "makePiManagedRuntimeLive")
                .mockImplementation((options) => {
                  constructed.push(options);
                  // Observation only: keep the actual production factory descriptors and private state.
                  return originalLive(options);
                });
              yield* Effect.addFinalizer(() => Effect.sync(() => factorySpy.mockRestore()));
              const stagingRoot =
                ownedScratchDirectory +
                "/concurrent-stage-" +
                (omitSiblingRegistration ? "negative" : "positive");
              const factory = yield* makePiProductionRuntime(
                {
                  environmentId: "environment",
                  distributionDirectory,
                  agentDirectory: f.options.agentDirectory,
                  nativeStateRoot: f.options.nativeStateRoot,
                  stagingRoot,
                  protectedRoots: [...f.options.protectedRoots, evidence],
                  memoryBytes: 536870912,
                  cleanupDeadlineMs: 5000,
                  maxInputTokens: 16_384,
                  maxOutputTokens: 2_048,
                },
                {
                  subscriptionTest: {
                    selection: subscriptionSelection(f),
                    credentialSource: { directory: f.options.agentDirectory, format: "pi" },
                  },
                },
              ).pipe(
                Effect.provideService(
                  PiModelCatalogue,
                  PiModelCatalogue.of({
                    readFresh: Effect.succeed(undefined),
                    refresh: Effect.die("Catalogue/backend calls forbidden"),
                  }),
                ),
                Effect.provideService(FetchHttpClient.Fetch, transport),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed),
              );
              const instance = yield* factory.forInstance({
                instanceId: providerInstanceId,
                enabled: true,
                configuration: {},
              });
              yield* Effect.addFinalizer(() => instance.stopAll.pipe(Effect.orDie));
              expect(constructed).toHaveLength(1);
              const factoryOptions = constructed[0]!;
              const controllers = factoryOptions.subscriptionAbortControllers;
              const accountingState = factoryOptions.subscriptionAccountingState;
              if (!controllers || !accountingState)
                return yield* Effect.die("Production shared state absent");
              const closure = yield* Effect.forEach(factoryOptions.runtimeFiles, (file) =>
                fs.readFile(file.source).pipe(
                  Effect.map((bytes) => ({
                    ...file,
                    bytes: bytes.length,
                    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
                  })),
                ),
              );
              yield* fs.writeFileString(evidence + "/closure.json", json(closure));
              const initializationTerminals: Array<SessionRuntime.PiSessionTerminal> = [];
              const sessionReceipts = yield* makeProjectTeamSessionReceipts({
                environmentId: "environment",
                maximumEnvironmentModelCalls: 4,
              });
              const journal = yield* makeProjectTeamDispatchJournal({
                environmentId: "environment",
                maximumEnvironmentModelCalls: 4,
                verifyStage: (receipt, original) =>
                  Effect.gen(function* () {
                    expect(receipt.evidence.bindingId).toBe(original.intent.request.git.runId);
                    if (receipt.stage === "session-bound" || receipt.stage === "assignment-intent")
                      expect(yield* sessionReceipts.readInitialization(original)).toBeDefined();
                  }).pipe(
                    Effect.mapError(
                      () =>
                        new ProjectTeamDispatchJournalError({
                          reason: "Concurrent stage receipt audit failed",
                        }),
                    ),
                  ),
              });
              for (const child of f.siblings) {
                let snapshot = child.snapshot;
                // Controlled no-script setup on actual disposable Git worktrees; both initializations
                // and both prompt groups below run the SDK and its real journal/process authority.
                for (const stage of ["workspace-ready", "setup-complete"] as const)
                  snapshot = yield* journal.readRetained(
                    (yield* journal.advanceStage(snapshot.fence, {
                      receiptId: `${child.request.dispatchId}-${stage}`,
                      stage,
                      evidence: { bindingId: child.binding.recordId },
                    })).fence.dispatchId,
                  );
                const initialized = yield* instance.prepareOperation(
                  {
                    threadId: child.binding.threadId,
                    kind: "initialize",
                    operationId: child.request.initializeOperationId,
                  },
                  () => Effect.void,
                );
                const result = yield* initialized.run;
                expect(result.terminal.outcome).toBe("success");
                expect(result.terminal.native?.persisted).toBe(true);
                initializationTerminals.push(result.terminal);
                for (const stage of ["session-bound", "assignment-intent"] as const)
                  snapshot = yield* journal.readRetained(
                    (yield* journal.advanceStage(snapshot.fence, {
                      receiptId: `${child.request.dispatchId}-${stage}`,
                      stage,
                      evidence: {
                        bindingId: child.binding.recordId,
                        initializeOperationId: child.request.initializeOperationId,
                      },
                    })).fence.dispatchId,
                  );
              }
              expect(calls).toBe(0);
              expect(controllers.size).toBe(0);
              const promptA = yield* instance.prepareOperation(
                {
                  threadId: first.binding.threadId,
                  kind: "prompt",
                  operationId: first.request.assignmentOperationId,
                  prompt: first.request.assignment,
                },
                () => Effect.void,
              );
              expect(controllers.size).toBe(1);
              const controllerA = [...controllers][0]!;
              const promptB = yield* instance.prepareOperation(
                {
                  threadId: second.binding.threadId,
                  kind: "prompt",
                  operationId: second.request.assignmentOperationId,
                  prompt: second.request.assignment,
                },
                () => Effect.void,
              );
              expect(controllers.size).toBe(2);
              const controllerB = [...controllers].find((controller) => controller !== controllerA);
              if (!controllerB) return yield* Effect.die("Second actual native controller absent");
              // Negative control changes exactly one registration. The second SDK, operation,
              // native descriptor, accounting ports and original authority are unchanged.
              if (omitSiblingRegistration) expect(controllers.delete(controllerB)).toBe(true);
              const runningA = yield* Effect.forkChild(promptA.run.pipe(Effect.result));
              const runningB = yield* Effect.forkChild(promptB.run.pipe(Effect.result));
              yield* Effect.gen(function* () {
                yield* Effect.raceFirst(
                  Effect.promise(() => Promise.all(arrived.map((receipt) => receipt.promise))),
                  Effect.raceFirst(Fiber.join(runningA), Fiber.join(runningB)).pipe(
                    Effect.flatMap(() =>
                      Effect.die("A native group terminated before both real requests arrived"),
                    ),
                  ),
                );
                const live = yield* f.sql<{
                  operation_id: string;
                  unit: string;
                  allocation_json: string;
                  owner_json: string;
                }>`
              SELECT o.operation_id,p.unit,p.allocation_json,p.owner_json FROM project_team_pi_operation o
              JOIN project_team_pi_process p ON p.operation_id=o.operation_id
              WHERE o.operation_id IN (${promptA.operation.operationId},${promptB.operation.operationId})
                AND o.status='running' AND p.status='captured' LIMIT 3`;
                expect(live).toHaveLength(2);
                const held = yield* f.sql<{
                  operation_id: string;
                  root_task_id: string;
                  status: string;
                  run_id: string;
                  attempt_id: string;
                  generation: number;
                  maximum_input_tokens: number;
                  maximum_output_tokens: number;
                  accounting_mode: string;
                  unknown_maximum_tokens: number;
                }>`
              SELECT operation_id,root_task_id,status,run_id,attempt_id,generation,maximum_input_tokens,
                maximum_output_tokens,accounting_mode,unknown_maximum_tokens
              FROM project_team_model_request WHERE operation_id IN (${promptA.operation.operationId},${promptB.operation.operationId}) ORDER BY operation_id LIMIT 3`;
                expect(held).toHaveLength(2);
                for (const row of held) {
                  const child = f.siblings.find(
                    (entry) => entry.request.assignmentOperationId === row.operation_id,
                  );
                  if (!child)
                    return yield* Effect.die("Held request lost its original child authority");
                  expect(row).toMatchObject({
                    root_task_id: f.root.binding.taskId,
                    run_id: child.binding.recordId,
                    attempt_id: child.binding.attemptId,
                    generation: child.binding.generation,
                    maximum_input_tokens: 16_384,
                    maximum_output_tokens: 2_048,
                    status: "held",
                    accounting_mode: "openai-subscription-monitored",
                    unknown_maximum_tokens: 64_000,
                  });
                }
                const budget =
                  yield* f.sql`SELECT task_id,deadline_at_ms,memory_bytes FROM project_task_resource_budget LIMIT 3`;
                expect(budget).toEqual([
                  {
                    task_id: f.root.binding.taskId,
                    deadline_at_ms: originalDeadlineAtMs,
                    memory_bytes: 2147483648,
                  },
                ]);
                const activeResources =
                  yield* f.sql`SELECT task_id,unit,memory_bytes FROM project_task_resource_child WHERE drain_json IS NULL LIMIT 3`;
                expect(activeResources).toHaveLength(2);
                for (const row of activeResources)
                  expect(row).toMatchObject({
                    task_id: f.root.binding.taskId,
                    memory_bytes: 536870912,
                  });
                const journals: Array<{ operationId: string; path: string; content: string }> = [];
                for (const [index, child] of f.siblings.entries()) {
                  const row = live.find(
                    (entry) => entry.operation_id === child.request.assignmentOperationId,
                  );
                  const native = initializationTerminals[index]?.native;
                  if (!row || !native)
                    return yield* Effect.die("Actual prompt/native owner absent");
                  const allocation = decodeConcurrentAllocation(row.allocation_json);
                  const owner = decodeConcurrentOwner(row.owner_json);
                  const identities = captured.filter((identity) => identity.unit === row.unit);
                  expect(identities.map((identity) => identity.kind)).toEqual([
                    "launcher",
                    "owner",
                    "started",
                  ]);
                  expect(identities[1]?.pid).toBe(owner.pid);
                  expect(allocation).toMatchObject({
                    policy: { memoryBytes: 536870912, runtimeSeconds: 60 },
                  });
                  expect(
                    allocation.launch.runtimeFiles.map(({ source, target }) => ({
                      source,
                      target,
                    })),
                  ).toEqual(
                    factoryOptions.runtimeFiles.map(({ source, target }) => ({ source, target })),
                  );
                  expect(yield* fs.readFileString(owner.cgroup + "/pids.max")).toBe("128\n");
                  const cpu = (yield* fs.readFileString(owner.cgroup + "/cpu.max"))
                    .trim()
                    .split(" ")
                    .map(Number);
                  expect(cpu[0]! / cpu[1]!).toBe(2);
                  // Read the real namespace from its immutable owned allocation.
                  const path = allocation.launch.nativeStateRoot + "/" + native.sessionReference;
                  const stat = yield* fs.stat(path);
                  expect(Number(stat.size)).toBeLessThanOrEqual(1048576);
                  const content = yield* fs.readFileString(path);
                  const users = content
                    .trim()
                    .split("\n")
                    .map((line) => decodeNativeJsonEvidence(line).message)
                    .filter(isConcurrentUserMessage);
                  expect(
                    users.some((message) =>
                      message.content.some((part) => part.text === child.request.assignment),
                    ),
                  ).toBe(true);
                  expect(content).toContain(native.sessionId);
                  expect(allocation.launch.protectedRoots).toContain(f.request.git.primaryRoot);
                  journals.push({
                    operationId: child.request.assignmentOperationId,
                    path,
                    content,
                  });
                }
                expect(signals.map((signal) => signal?.aborted)).toEqual([false, false]);
                expect(controllerA.signal.aborted).toBe(false);
                expect(controllerB.signal.aborted).toBe(false);
                yield* fs.writeFileString(
                  evidence + "/concurrent-barrier.json",
                  json({
                    live,
                    held,
                    budget,
                    activeResources,
                    journals,
                    requests,
                    captured,
                    approvedAtMs,
                    originalDeadlineAtMs,
                    root: originalRoot,
                    children: f.siblings.map((child) => child.snapshot.intent),
                    qualification:
                      "Controlled parent initialization and no-script setup receipts; actual SDK initializations and two concurrent native SDK prompt groups; synthetic OAuth/intercepted HTTP only; zero external model/backend calls",
                  }),
                );
                failFirst.resolve();
                const resultA = yield* Fiber.join(runningA);
                expect(resultA._tag).toBe("Failure");
                expect(controllerA.signal.aborted).toBe(true);
                const grant =
                  yield* f.sql`SELECT root_task_id,maximum_tokens,maximum_duration_ms,deadline_at_ms,stop_reason,stopped_at_ms
              FROM project_team_pi_subscription_grant LIMIT 2`;
                expect(grant).toEqual([
                  {
                    root_task_id: f.root.binding.taskId,
                    maximum_tokens: 64_000,
                    maximum_duration_ms: 300_000,
                    deadline_at_ms: originalDeadlineAtMs,
                    stop_reason: "unknown-usage",
                    stopped_at_ms: expect.any(Number),
                  },
                ]);
                if (omitSiblingRegistration) {
                  expect(controllerB.signal.aborted).toBe(false);
                  expect(signals[1]?.aborted).toBe(false);
                  const secondLive =
                    yield* f.sql`SELECT o.status,p.drain_json,o.terminal_json FROM project_team_pi_operation o
                JOIN project_team_pi_process p ON p.operation_id=o.operation_id WHERE o.operation_id=${promptB.operation.operationId}`;
                  expect(secondLive).toEqual([
                    { status: "running", drain_json: null, terminal_json: null },
                  ]);
                  const siblingOwner = live.find(
                    (row) => row.operation_id === promptB.operation.operationId,
                  )!;
                  for (const identity of captured.filter(
                    (item) => item.unit === siblingOwner.unit,
                  )) {
                    const stat = yield* fs.readFileString(`/proc/${identity.pid}/stat`);
                    expect(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19]).toBe(
                      identity.startTime,
                    );
                  }
                  yield* fs.writeFileString(
                    evidence + "/negative-before-teardown.json",
                    json({
                      secondLive,
                      unit: siblingOwner.unit,
                      captured: captured.filter((item) => item.unit === siblingOwner.unit),
                      siblingControllerAborted: controllerB.signal.aborted,
                      transportAborted: signals[1]?.aborted,
                    }),
                  );
                  // Public runtime stop owns the captured exact native owner and joins its cleanup.
                  yield* instance.requestStop(second.binding.threadId);
                } else {
                  expect(controllerB.signal.aborted).toBe(true);
                  yield* Effect.promise(() => transportAborted[1]!.promise);
                }
                const resultB = yield* Fiber.join(runningB);
                expect(resultB._tag).toBe("Failure");
                const terminals = yield* f.sql<{
                  operation_id: string;
                  status: string;
                  terminal_json: string;
                  unit: string;
                  owner_json: string;
                  drain_json: string;
                }>`
              SELECT o.operation_id,o.status,o.terminal_json,p.unit,p.owner_json,p.drain_json FROM project_team_pi_operation o
              JOIN project_team_pi_process p ON p.operation_id=o.operation_id
              WHERE o.operation_id IN (${first.request.initializeOperationId},${second.request.initializeOperationId},${promptA.operation.operationId},${promptB.operation.operationId})
              ORDER BY o.operation_id LIMIT 5`;
                expect(terminals).toHaveLength(4);
                for (const row of terminals) {
                  const owner = parseOwner(row.owner_json);
                  const drain = parseFullDrain(row.drain_json);
                  const terminal = decodeNativeJsonEvidence(row.terminal_json);
                  expect(terminal).toMatchObject({
                    operation: { operationId: row.operation_id },
                    ownerCaptured: true,
                    drain,
                  });
                  expect(drain).toMatchObject({
                    unit: row.unit,
                    ownerPid: owner.pid,
                    invocation: owner.invocation,
                    memoryBytes: 536870912,
                    swapBytes: 0,
                    oomGroup: 1,
                  });
                  expect(
                    drain.kernel === "removed" || drain.kernel.split("\n").includes("populated 0"),
                  ).toBe(true);
                  const identities = captured.filter((item) => item.unit === row.unit);
                  expect(identities.map((item) => item.kind)).toEqual([
                    "launcher",
                    "owner",
                    "started",
                  ]);
                  expect(identities.map((item) => item.pid)).toEqual([
                    drain.launcherPid,
                    drain.ownerPid,
                    drain.childPid,
                  ]);
                  for (const identity of identities) {
                    const stat = yield* fs
                      .readFileString(`/proc/${identity.pid}/stat`)
                      .pipe(Effect.option);
                    if (Option.isSome(stat))
                      expect(
                        stat.value.slice(stat.value.lastIndexOf(") ") + 2).split(" ")[19],
                      ).not.toBe(identity.startTime);
                  }
                  if (yield* fs.exists(drain.cgroup + "/cgroup.events"))
                    expect(yield* fs.readFileString(drain.cgroup + "/cgroup.events")).toContain(
                      "populated 0",
                    );
                }
                expect(captured).toHaveLength(12);
                const resources = yield* f.sql<{
                  unit: string;
                  task_id: string;
                  drain_json: string | null;
                }>`SELECT unit,task_id,drain_json FROM project_task_resource_child LIMIT 6`;
                for (const row of terminals)
                  expect(resources.find((resource) => resource.unit === row.unit)).toMatchObject({
                    task_id: f.root.binding.taskId,
                    drain_json: row.drain_json,
                  });
                expect(
                  yield* f.sql`SELECT unit FROM project_task_resource_child WHERE drain_json IS NULL LIMIT 1`,
                ).toEqual([]);
                const accounting =
                  yield* f.sql`SELECT operation_id,root_task_id,status,capacity_state,charged_input_tokens,charged_output_tokens,accounting_receipt_id
              FROM project_team_model_request ORDER BY operation_id LIMIT 3`;
                expect(accounting).toHaveLength(2);
                for (const row of accounting)
                  expect(row).toMatchObject({
                    root_task_id: f.root.binding.taskId,
                    status: "unknown",
                    capacity_state: "quarantine",
                    charged_input_tokens: 16_384,
                    charged_output_tokens: 64_000,
                    accounting_receipt_id: expect.any(String),
                  });
                expect(calls).toBe(2);
                expect(constructed).toHaveLength(1);
                expect(factoryOptions.subscriptionAbortControllers).toBe(controllers);
                expect(factoryOptions.subscriptionAccountingState).toBe(accountingState);
                const retainedRoot = yield* journal.readRetained(f.root.request.dispatchId);
                expect(retainedRoot.intent).toEqual(originalRoot);
                yield* fs.writeFileString(
                  evidence + "/joined-results.json",
                  json({
                    terminals,
                    resources,
                    accounting,
                    grant,
                    captured,
                    resultA,
                    resultB,
                    calls,
                    omitSiblingRegistration,
                  }),
                );
              }).pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    // Always stop both exact bindings, including a barrier/assertion failure. Do not
                    // leave a transport gate waiting while stopping and joining captured native owners.
                    failFirst.resolve();
                    yield* instance.stopAll.pipe(Effect.orDie);
                    yield* Fiber.join(runningA);
                    yield* Fiber.join(runningB);
                  }).pipe(Effect.uninterruptible),
                ),
              );
            }),
          ),
        120000,
      );
  },
);

it.effect(
  "denies a subscription model without the private root selection before native preparation",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* dispatchedRuntimeFixture(subscriptionRuntimeProfile);
        let catalogueReads = 0;
        const runtime = yield* makePiManagedRuntimeLive({
          ...f.options,
          readCatalogue: f.options.readCatalogue.pipe(
            Effect.tap(() => Effect.sync(() => catalogueReads++)),
          ),
        });
        const instance = yield* runtime.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: {},
        });
        const result = yield* instance
          .prepareOperation(
            {
              threadId: f.binding.threadId,
              kind: "initialize",
              operationId: f.request.initializeOperationId,
            },
            () => Effect.void,
          )
          .pipe(Effect.result);

        expect(result._tag).toBe("Failure");
        expect(catalogueReads).toBe(0);
        expect(f.allocations).toBe(0);
        expect(f.transports).toBe(0);
        expect(yield* f.fs.readDirectory(f.options.nativeStateRoot)).toEqual([]);
        expect(yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).toEqual([]);
        expect(yield* f.sql`SELECT reservation_id FROM project_team_model_request`).toEqual([]);
      }),
    ),
);

it.effect(
  "keeps private Luna selection on the actual Live bootstrap and parent credential broker",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* dispatchedRuntimeFixture(subscriptionRuntimeProfile);
        const selection = subscriptionSelection(f);
        const deadlineAtMs = f.snapshot.intent.limits.rootDeadlineAtMs;
        const accessToken = `header.${Buffer.from(
          json({
            exp: Math.ceil(deadlineAtMs / 1000) + 60,
            "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
          }),
        ).toString("base64url")}.signature`;
        yield* f.fs.writeFileString(
          f.options.agentDirectory + "/auth.json",
          json({
            "openai-codex": {
              type: "oauth",
              access: accessToken,
              expires: deadlineAtMs + 60_000,
              accountId: "fixture-account",
            },
          }),
        );
        let catalogueReads = 0;
        const options: PiManagedRuntimeLiveOptions = {
          ...f.options,
          subscriptionTest: {
            selection,
            credentialSource: { directory: f.options.agentDirectory, format: "pi" },
          },
          readCatalogue: f.options.readCatalogue.pipe(
            Effect.tap(() => Effect.sync(() => catalogueReads++)),
          ),
        };
        const runtime = yield* makePiManagedRuntimeLive(options);
        const instance = yield* runtime.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: {},
        });
        let captured: SessionRuntime.PiSessionRuntimeOptions | undefined;
        const original = SessionRuntime.makePiSessionRuntime;
        const spy = vi.spyOn(SessionRuntime, "makePiSessionRuntime").mockImplementation((input) => {
          captured = input;
          return original(input);
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        const prepared = yield* instance.prepareOperation(
          {
            threadId: f.binding.threadId,
            kind: "initialize",
            operationId: f.request.initializeOperationId,
          },
          () => Effect.void,
        );
        if (!captured) return yield* Effect.die("Live did not construct the intercepted session");
        expect(captured.bootstrap.model).toMatchObject({
          provider: "openai-codex",
          modelId: "gpt-6-luna",
          api: "openai-codex-responses",
          maxTokens: 2_048,
          reasoning: true,
          reasoningEffort: "high",
          serviceTier: "default",
        });
        expect(captured.broker).toMatchObject({
          provider: "openai-codex",
          model: "gpt-6-luna",
          routeId: "openai-subscription-luna",
          endpoint: "https://chatgpt.com/backend-api/codex/responses",
        });
        expect(
          yield* Effect.tryPromise(() =>
            captured!.broker.getCredential(new AbortController().signal),
          ),
        ).toBe(accessToken);
        expect(catalogueReads).toBe(0);
        expect(f.transports).toBe(0);
        yield* instance.stopAll;
        expect(prepared.operation.operationId).toBe(f.request.initializeOperationId);
      }),
    ),
);

it.effect(
  "a stopped subscription root refuses preparation before native state or model access",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* dispatchedRuntimeFixture(subscriptionRuntimeProfile);
        const selection = subscriptionSelection(f);
        yield* f.sql`INSERT INTO project_team_pi_subscription_grant
        (environment_id,project_id,root_task_id,model,route_id,maximum_tokens,maximum_duration_ms,
         deadline_at_ms,stopped_at_ms,stop_reason)
        VALUES ('environment',${selection.projectId},${selection.rootTaskId},'gpt-6-luna',
          'openai-subscription-luna',64000,300000,${f.snapshot.intent.limits.rootDeadlineAtMs},
          ${Date.parse(at) + 1},'threshold-reached')`;
        let catalogueReads = 0;
        const runtime = yield* makePiManagedRuntimeLive({
          ...f.options,
          subscriptionTest: {
            selection,
            credentialSource: { directory: f.options.agentDirectory, format: "pi" },
          },
          readCatalogue: f.options.readCatalogue.pipe(
            Effect.tap(() => Effect.sync(() => catalogueReads++)),
          ),
        });
        const instance = yield* runtime.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: {},
        });
        const result = yield* instance
          .prepareOperation(
            {
              threadId: f.binding.threadId,
              kind: "initialize",
              operationId: f.request.initializeOperationId,
            },
            () => Effect.void,
          )
          .pipe(Effect.result);

        expect(result._tag).toBe("Failure");
        expect(catalogueReads).toBe(0);
        expect(f.allocations).toBe(0);
        expect(f.transports).toBe(0);
        expect(yield* f.fs.readDirectory(f.options.nativeStateRoot)).toEqual([]);
        expect(yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).toEqual([]);
        expect(yield* f.sql`SELECT reservation_id FROM project_team_model_request`).toEqual([]);
      }),
    ),
);

for (const stopFailure of ["settlement", "post-commit-stop-read"] as const)
  it.live(
    `unknown subscription usage aborts the managed controller and controlled sibling after ${stopFailure}`,
    () =>
      scoped(
        Effect.gen(function* () {
          const originalClockAtMs = DateTime.toEpochMillis(DateTime.nowUnsafe());
          const f = yield* requiredTransferFixture(
            false,
            false,
            undefined,
            false,
            "project",
            "Investigate current assignment",
            { ...subscriptionRuntimeProfile, originalClockAtMs },
          );
          const selection = subscriptionSelection(f);
          const deadlineAtMs = f.snapshot.intent.limits.rootDeadlineAtMs;
          const accessToken = `header.${Buffer.from(
            json({
              exp: Math.ceil(deadlineAtMs / 1000) + 60,
              "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
            }),
          ).toString("base64url")}.signature`;
          yield* f.fs.writeFileString(
            f.options.agentDirectory + "/auth.json",
            json({
              "openai-codex": {
                type: "oauth",
                access: accessToken,
                expires: deadlineAtMs + 60_000,
                accountId: "fixture-account",
              },
            }),
          );
          // The current controller is registered by the actual managed runtime; the sibling is an
          // explicitly controlled in-flight peer used to prove root-wide cancellation and join.
          const controlledSibling = new AbortController();
          const controlledSiblingJoined = Promise.withResolvers<void>();
          controlledSibling.signal.addEventListener(
            "abort",
            () => controlledSiblingJoined.resolve(),
            { once: true },
          );
          const controllers = new Set<AbortController>([controlledSibling]);
          let transports = 0;
          let requestBody: unknown;
          let actualRuntimeSignal: AbortSignal | undefined;
          let stopReadFailureInjected = false;
          if (stopFailure === "settlement")
            yield* f.sql`CREATE TRIGGER injected_subscription_settlement_failure
            BEFORE UPDATE OF status ON project_team_model_request
            WHEN NEW.accounting_mode='openai-subscription-monitored' AND NEW.status='unknown'
            BEGIN SELECT RAISE(ABORT,'injected subscription settlement failure'); END`;
          if (stopFailure === "post-commit-stop-read") {
            const originalPolicy = PiModelAccounting.makeProjectTeamPiSubscriptionParentPolicy;
            const policySpy = vi
              .spyOn(PiModelAccounting, "makeProjectTeamPiSubscriptionParentPolicy")
              .mockImplementation((sql, selection) => {
                const policy = originalPolicy(sql, selection);
                return {
                  ...policy,
                  readStop: (identity) =>
                    Effect.gen(function* () {
                      const stopped = yield* policy.readStop(identity);
                      const committedTargetSettlement = yield* sql<{
                        status: string;
                        capacity_state: string;
                        accounting_receipt_id: string | null;
                      }>`SELECT status,capacity_state,accounting_receipt_id
                      FROM project_team_model_request
                      WHERE operation_id=${f.request.assignmentOperationId}
                        AND root_task_id=${selection.rootTaskId}
                        AND accounting_mode='openai-subscription-monitored'
                        AND status='unknown' AND capacity_state='quarantine'
                        AND accounting_receipt_id IS NOT NULL`.pipe(
                        Effect.mapError(
                          () =>
                            new PiModelAccounting.ModelAccountingError({
                              reason: "Controlled subscription settlement read failed",
                            }),
                        ),
                      );
                      if (
                        stopped &&
                        !stopReadFailureInjected &&
                        committedTargetSettlement.length === 1
                      ) {
                        stopReadFailureInjected = true;
                        yield* sql.unsafe("SELECT * FROM injected_subscription_stop_read").pipe(
                          Effect.mapError(
                            () =>
                              new PiModelAccounting.ModelAccountingError({
                                reason: "Injected post-commit subscription stop-read failure",
                              }),
                          ),
                          Effect.as(stopped),
                        );
                      }
                      return stopped;
                    }),
                };
              });
            yield* Effect.addFinalizer(() => Effect.sync(() => policySpy.mockRestore()));
          }
          const runtime = yield* makePiManagedRuntimeLive({
            ...f.options,
            subscriptionTest: {
              selection,
              credentialSource: { directory: f.options.agentDirectory, format: "pi" },
            },
            subscriptionAbortControllers: controllers,
            transport: async (_endpoint, input) => {
              transports++;
              requestBody = decodeNativeJsonEvidence(input.body);
              actualRuntimeSignal = [...controllers].find(
                (controller) => controller !== controlledSibling,
              )?.signal;
              return new Response("intercepted fixture failure", { status: 503 });
            },
          });
          const instance = yield* runtime.forInstance({
            instanceId: providerInstanceId,
            enabled: true,
            configuration: {},
          });
          yield* initializeRequiredContext(f, false, instance);
          let captured: SessionRuntime.PiSessionRuntimeOptions | undefined;
          let controlledRunFailure: unknown;
          const controlledRunFinished = Promise.withResolvers<void>();
          const original = SessionRuntime.makePiSessionRuntime;
          const spy = vi
            .spyOn(SessionRuntime, "makePiSessionRuntime")
            .mockImplementation((input) => {
              captured = input;
              return original(input).pipe(
                Effect.map((session) => ({
                  ...session,
                  run: () =>
                    Effect.gen(function* () {
                      // Exercise the exact prompt owner, allocation, broker, and accounting ports, then
                      // persist uncertainty without starting a native child or inventing a drain.
                      // The parent stop and this completion receipt join terminal persistence.
                      if (input.operation.operationKind !== "prompt")
                        return yield* Effect.die("Expected the original assignment prompt owner");
                      const promptText = input.transferTexts.find(
                        (entry) => entry.transferId === "prompt",
                      )?.text;
                      if (promptText !== f.request.assignment)
                        return yield* Effect.die(
                          "Prompt owner lost the retained assignment context",
                        );
                      const signal = yield* Effect.abortSignal;
                      const allocation = input.persistence.allocation;
                      // Controlled owner metadata only; this fixture starts no child or certified drain.
                      const owner = {
                        type: "owner" as const,
                        unit: allocation.unit,
                        nonce: allocation.nonce,
                        invocation: "b".repeat(32),
                        cgroup: `/sys/fs/cgroup/controlled/${allocation.unit}`,
                        pid: 99999999,
                        memoryBytes: allocation.policy.memoryBytes,
                        swapBytes: 0,
                        oomGroup: 1,
                      };
                      yield* Effect.promise(() =>
                        input.authorizeCurrent(
                          {
                            identity: input.identity,
                            operation: input.operation,
                            phase: "beforeAcquire",
                          },
                          signal,
                        ),
                      );

                      yield* input.persistence.claimActivation(allocation);

                      yield* input.persistence.beforeStart(owner);

                      const broker = makePiModelBroker(input.broker);
                      const failure = yield* Effect.promise(() =>
                        broker
                          .request({
                            body: json({
                              model: "gpt-6-luna",
                              store: false,
                              stream: true,
                              instructions: input.transferTexts.find(
                                (entry) => entry.transferId === "context",
                              )?.text,
                              input: [{ type: "message", role: "user", content: promptText }],
                              text: { verbosity: "high" },
                              include: ["reasoning.encrypted_content"],
                              tool_choice: "auto",
                              parallel_tool_calls: true,
                              reasoning: { effort: "high", summary: "auto" },
                              service_tier: "default",
                            }),
                            requestId: 1,
                            signal,
                            onChunk: async () => {},
                          })
                          .then(
                            () => undefined,
                            (error: unknown) => error,
                          ),
                      );

                      expect(failure).toMatchObject({ code: "SETTLEMENT_FAILED" });
                      const terminal: SessionRuntime.PiSessionTerminal = {
                        identity: input.identity,
                        operation: input.operation,
                        outcome: "quarantine",
                        ownerCaptured: true,
                        native: null,
                        drain: null,
                        accountingReceipts: [],
                      };
                      yield* Effect.tryPromise({
                        try: () =>
                          input.persistTerminal(
                            terminal,
                            AbortSignal.timeout(input.cleanupDeadlineMs),
                          ),
                        catch: () =>
                          new SessionRuntime.PiSessionRuntimeError({
                            code: "CONTROLLED_SUBSCRIPTION_TERMINAL",
                          }),
                      });
                      return terminal;
                    }).pipe(
                      Effect.uninterruptible,
                      Effect.tapCause((cause) =>
                        Effect.sync(() => {
                          controlledRunFailure = cause;
                        }),
                      ),
                      Effect.ensuring(Effect.sync(() => controlledRunFinished.resolve())),
                    ),
                })),
              );
            });
          yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
          const prepared = yield* instance.prepareOperation(
            {
              threadId: f.binding.threadId,
              kind: "prompt",
              operationId: f.request.assignmentOperationId,
              prompt: f.request.assignment,
            },
            () => Effect.void,
          );
          expect(controllers.size).toBe(2);
          if (!captured) return yield* Effect.die("Live did not construct the controlled broker");
          const runResult = yield* prepared.run.pipe(Effect.result);

          expect(runResult._tag).toBe("Failure");
          if (stopFailure === "post-commit-stop-read") expect(stopReadFailureInjected).toBe(true);
          expect(transports).toBe(1);
          expect(requestBody).toMatchObject({
            model: "gpt-6-luna",
            store: false,
            stream: true,
            instructions: expect.any(String),
            input: [{ type: "message", role: "user", content: f.request.assignment }],
            text: { verbosity: "high" },
            include: ["reasoning.encrypted_content"],
            tool_choice: "auto",
            parallel_tool_calls: true,
            reasoning: { effort: "high", summary: "auto" },
            service_tier: "default",
          });
          expect(requestBody).not.toHaveProperty("messages");
          expect(requestBody).not.toHaveProperty("max_tokens");
          expect(requestBody).not.toHaveProperty("stream_options");

          const settled = yield* f.sql<{
            status: string;
            capacity_state: string;
            charged_input_tokens: number;
            charged_output_tokens: number;
            accounting_receipt_id: string | null;
            operation_id: string;
            worker_id: string;
            generation: number;
            run_id: string;
            attempt_id: string;
            root_task_id: string;
            model: string;
            route_id: string;
            maximum_input_tokens: number;
            maximum_output_tokens: number;
            unknown_maximum_tokens: number | null;
          }>`SELECT status,capacity_state,charged_input_tokens,charged_output_tokens,accounting_receipt_id
          ,operation_id,worker_id,generation,run_id,attempt_id,root_task_id,model,route_id,
          maximum_input_tokens,maximum_output_tokens,unknown_maximum_tokens
        FROM project_team_model_request WHERE operation_id=${prepared.operation.operationId}`;
          expect(settled).toHaveLength(1);
          expect(settled[0]).toMatchObject({
            status: stopFailure === "settlement" ? "held" : "unknown",
            capacity_state: stopFailure === "settlement" ? "held" : "quarantine",
            charged_input_tokens: stopFailure === "settlement" ? 0 : 16_384,
            charged_output_tokens: stopFailure === "settlement" ? 0 : 64_000,
            operation_id: f.request.assignmentOperationId,
            worker_id: captured.identity.workerId,
            generation: f.binding.generation,
            run_id: f.binding.recordId,
            attempt_id: f.binding.attemptId,
            root_task_id: selection.rootTaskId,
            model: "gpt-6-luna",
            route_id: "openai-subscription-luna",
            maximum_input_tokens: 16_384,
            maximum_output_tokens: 2_048,
            unknown_maximum_tokens: 64_000,
          });
          if (stopFailure === "settlement") expect(settled[0]?.accounting_receipt_id).toBeNull();
          else expect(settled[0]?.accounting_receipt_id).toEqual(expect.any(String));
          expect(
            yield* f.sql<{
              stopped_at_ms: number | null;
              stop_reason: string | null;
              model: string;
              route_id: string;
              maximum_tokens: number;
              maximum_duration_ms: number;
              deadline_at_ms: number;
            }>`SELECT stopped_at_ms,stop_reason,model,route_id,maximum_tokens,maximum_duration_ms,deadline_at_ms
          FROM project_team_pi_subscription_grant
          WHERE environment_id='environment' AND project_id=${selection.projectId} AND root_task_id=${selection.rootTaskId}`,
          ).toMatchObject([
            {
              stopped_at_ms: stopFailure === "settlement" ? null : expect.any(Number),
              stop_reason: stopFailure === "settlement" ? null : "unknown-usage",
              model: "gpt-6-luna",
              route_id: "openai-subscription-luna",
              maximum_tokens: 64_000,
              maximum_duration_ms: 300_000,
              deadline_at_ms: deadlineAtMs,
            },
          ]);
          expect(actualRuntimeSignal?.aborted).toBe(true);
          expect(controlledSibling.signal.aborted).toBe(true);
          yield* Effect.promise(() => controlledSiblingJoined.promise);
          yield* instance.stopAll;
          yield* Effect.promise(() => controlledRunFinished.promise);
          expect(controlledRunFailure).toBeUndefined();
          controllers.delete(controlledSibling);
          expect(controllers.size).toBe(0);
          expect(
            yield* f.sql<{
              operation_kind: string;
              status: string;
              outcome: string | null;
            }>`SELECT operation_kind,status,json_extract(terminal_json,'$.outcome') AS outcome
          FROM project_team_pi_operation WHERE operation_id=${prepared.operation.operationId}`,
          ).toEqual([{ operation_kind: "prompt", status: "quarantine", outcome: "quarantine" }]);

          const nativeDenial = yield* Effect.promise(() =>
            captured!
              .authorizeCurrent(
                {
                  identity: captured!.identity,
                  operation: captured!.operation,
                  phase: "beforeAcquire",
                },
                new AbortController().signal,
              )
              .then(
                () => undefined,
                (error: unknown) => error,
              ),
          );
          expect(nativeDenial).toMatchObject({
            code: "uncertain",
            detail: "Pi subscription accounting requires reconciliation",
          });

          const laterBroker = makePiModelBroker(captured.broker);
          const modelDenial = yield* Effect.promise(() =>
            laterBroker
              .request({
                body: json({
                  model: "gpt-6-luna",
                  store: false,
                  stream: true,
                  instructions: captured!.broker.requiredSystemText,
                  input: [{ type: "message", role: "user", content: "must be denied" }],
                  text: { verbosity: "high" },
                  include: ["reasoning.encrypted_content"],
                  tool_choice: "auto",
                  parallel_tool_calls: true,
                  reasoning: { effort: "high", summary: "auto" },
                  service_tier: "default",
                }),
                requestId: 2,
                signal: new AbortController().signal,
                onChunk: async () => {},
              })
              .then(
                () => undefined,
                (error: unknown) => error,
              ),
          );
          expect(modelDenial).toMatchObject({ code: "AUTHORIZATION_REJECTED" });
          expect(transports).toBe(1);
          expect(
            yield* f.sql`SELECT reservation_id FROM project_team_model_request
          WHERE operation_id=${prepared.operation.operationId}`,
          ).toHaveLength(1);

          const terminal = yield* f.sql<{
            status: string;
            outcome: string | null;
          }>`SELECT status,json_extract(terminal_json,'$.outcome') AS outcome
        FROM project_team_pi_operation WHERE operation_id=${prepared.operation.operationId}`;
          expect(terminal).toEqual([{ status: "quarantine", outcome: "quarantine" }]);
          expect(controllers.size).toBe(0);
          expect(
            yield* f.sql`SELECT operation_id FROM project_team_pi_process
          WHERE operation_id=${prepared.operation.operationId}`,
          ).toEqual([{ operation_id: prepared.operation.operationId }]);
          expect(
            yield* f.sql<{
              status: string;
              allocation_json: string;
              owner_json: string | null;
              drain_json: string | null;
            }>`SELECT status,allocation_json,owner_json,drain_json
          FROM project_team_pi_process WHERE operation_id=${prepared.operation.operationId}`,
          ).toMatchObject([
            {
              status: "quarantine",
              allocation_json: expect.any(String),
              owner_json: expect.any(String),
              drain_json: null,
            },
          ]);
        }),
      ),
  );

for (const readonlyKind of [undefined, "review"] as const)
  it.effect(
    `required context transfer qualifies the exact ${readonlyKind === undefined ? "approved-parent-plan" : "planless human-child"} reviewer text and preserves terminal replay`,
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
            threadId: f.binding.threadId,
            kind: "initialize" as const,
            operationId: f.request.initializeOperationId,
          };
          const prepared = yield* f.instance.prepareOperation(request, () => Effect.void);
          const initialized = yield* prepared.run;
          expect(initialized.terminal.outcome).toBe("success");
          expect(briefing.startsWith(required.text)).toBe(true);
          expect(briefing.includes("Verified review files: /review-target/<relative-file>")).toBe(
            true,
          );
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
            (record) => record.kind === "gate" && record.recordId === f.binding.authorizationGateId,
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
              threadId: f.binding.threadId,
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
            const drain = initialized.terminal.drain;
            if (!drain)
              return yield* Effect.die("Missing original controlled initialization drain");
            const journal = yield* makeProjectTeamDispatchJournal({
              environmentId: "environment",
              maximumEnvironmentModelCalls: 4,
              verifyStage: (receipt, original) =>
                Effect.gen(function* () {
                  if (
                    receipt.evidence.bindingId !== original.intent.request.git.runId ||
                    receipt.evidence.setupId !== original.intent.request.setupId
                  )
                    return yield* new ProjectTeamDispatchJournalError({
                      reason: "Foreign controlled review stage",
                    });
                  // The real callbacks already retained this exact controlled native owner and drain.
                  const joined = yield* f.sql`SELECT 1 FROM project_team_pi_operation AS operation
                  JOIN project_team_pi_process AS process ON process.operation_id=operation.operation_id
                  WHERE operation.operation_id=${f.request.initializeOperationId} AND operation.binding_id=${f.binding.recordId}
                    AND operation.status='settled' AND json_extract(operation.terminal_json,'$.outcome')='success'
                    AND json_extract(process.owner_json,'$.unit')=${drain.unit}
                    AND json_extract(process.owner_json,'$.invocation')=${drain.invocation}
                    AND json_extract(process.owner_json,'$.cgroup')=${drain.cgroup}
                    AND json_extract(process.drain_json,'$.unit')=${drain.unit}
                    AND json_extract(process.drain_json,'$.invocation')=${drain.invocation}
                    AND json_extract(process.drain_json,'$.cgroup')=${drain.cgroup}
                    AND json_extract(process.drain_json,'$.kernel')=${drain.kernel}`.pipe(
                    Effect.mapError(
                      () =>
                        new ProjectTeamDispatchJournalError({
                          reason: "Original controlled review initialization audit failed",
                        }),
                    ),
                  );
                  if (joined.length !== 1)
                    return yield* new ProjectTeamDispatchJournalError({
                      reason: "Original controlled review initialization is not joined",
                    });
                }),
            });
            let snapshot = yield* journal.readRetained(f.request.dispatchId);
            for (const stage of [
              "workspace-ready",
              "setup-complete",
              "session-bound",
              "assignment-intent",
            ] as const)
              snapshot = yield* journal.readRetained(
                (yield* journal.advanceStage(snapshot.fence, {
                  receiptId: `required-review-${stage}`,
                  stage,
                  evidence: { bindingId: f.binding.recordId, setupId: f.request.setupId },
                })).fence.dispatchId,
              );
            const current = yield* f.reader.readForOperation({
              projectId,
              bindingId: f.binding.recordId,
              generation: 0,
              providerInstanceId,
              threadId: f.binding.threadId,
              operationId: f.request.assignmentOperationId,
              operationKind: "prompt",
            });
            expect(current.required.tasks[0]?.plan).toBeUndefined();
            const prompt = yield* instance.prepareOperation(
              {
                threadId: f.binding.threadId,
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

it.effect(
  "explicit alternate runtime inspection advertises the selected catalogue model only",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const alternate = "inclusionai/ling-3.0-flash-sante:free" as const;
        const runtime = yield* makePiManagedRuntimeLive({
          ...f.options,
          readCatalogue: Effect.succeed({
            source: "https://api.commandcode.ai/provider/v1/models",
            fetchedAt: at,
            selectedEntry: {
              id: alternate,
              owned_by: "command-code",
              context_length: 20000,
              supported_endpoints: ["/chat/completions"],
            },
          }),
        });
        const instance = yield* runtime.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: {},
        });
        expect((yield* instance.inspect).models.map((entry) => entry.slug)).toEqual([alternate]);
        expect(f.launches).toBe(0);
        expect(f.transports).toBe(0);
      }),
    ),
);

it.effect(
  "readonly review target denies a workflow without its original repository permit host",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* requiredReviewTransferFixture();
        const construction = makePiManagedRuntimeLive(f.options);
        type Requirements = Effect.Services<typeof construction>;
        const runtime = yield* construction.pipe(
          Effect.updateContext((context: Context.Context<Requirements>) => {
            const services = new Map(context.mapUnsafe);
            services.delete(GitRepositoryPermits.key);
            return Context.makeUnsafe<Requirements>(services);
          }),
        );
        const instance = yield* runtime.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: {},
        });
        const result = yield* instance
          .prepareOperation(
            {
              threadId: f.binding.threadId,
              kind: "initialize",
              operationId: f.request.initializeOperationId,
            },
            () => Effect.void,
          )
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(f.allocations).toBe(0);
        expect(yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).toEqual([]);
      }),
    ),
);

for (const remainingMs of [300000, 80000, 20000])
  it.effect(`reviewer broker deadline preserves its original ${remainingMs}ms task remainder`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* requiredReviewTransferFixture(true);
        const originalDeadline = f.snapshot.intent.limits.rootDeadlineAtMs;
        yield* TestClock.setTime(originalDeadline - remainingMs);
        let captured: SessionRuntime.PiSessionRuntimeOptions | undefined;
        const original = SessionRuntime.makePiSessionRuntime;
        const spy = vi.spyOn(SessionRuntime, "makePiSessionRuntime").mockImplementation((input) => {
          captured = input;
          return original(input);
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        yield* f.instance.prepareOperation(
          {
            threadId: f.binding.threadId,
            kind: "initialize",
            operationId: f.request.initializeOperationId,
          },
          () => Effect.void,
        );
        if (!captured) return yield* Effect.die("Missing actual reviewer broker deadline");
        expect(captured.broker.deadlineMs).toBe(Math.min(120000, Math.floor(remainingMs / 2)));
        expect(captured.deadlineMs).toBeLessThanOrEqual(remainingMs);
        expect(f.snapshot.intent.limits.rootDeadlineAtMs).toBe(originalDeadline);
        const claim = f.snapshot.intent.compiledClaim.transition;
        if (claim?.kind !== "claim") return yield* Effect.die("Missing original reviewer claim");
        expect(claim.binding.configuration.maxDurationMs).toBe(300000);
        const rootClaim = f.root.snapshot.intent.compiledClaim.transition;
        if (rootClaim?.kind !== "claim") return yield* Effect.die("Missing original root claim");
        expect(rootClaim.binding.configuration.maxTokens).toBe(64000);
        expect(rootClaim.binding.configuration.maxDurationMs).toBe(300000);
        expect(f.transports).toBe(0);
        expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
      }),
    ),
  );

(process.env.PI_REVIEW_TARGET_NATIVE_DIST ? it.effect : it.effect.skip)(
  "production factory captures shared repository permits for readonly reviewer preparation",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* requiredReviewTransferFixture(true);
        const git = GitVcsDriver.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pi-review-factory-" })),
        );
        const registry = VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pi-review-registry-" })),
        );
        const canonicalWorkflow = GitWorkflow.layer.pipe(
          Layer.provide(git),
          Layer.provide(registry),
          // Reviewer preparation never uses the mutation/status manager methods.
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
        );
        const captured = yield* Layer.build(canonicalWorkflow);
        const workflow = Context.get(captured, GitWorkflowService);
        const sharedPermits = Context.get(captured, GitRepositoryPermits);
        const workflowCalls = vi.spyOn(sharedPermits, "withRepositoryPermit");
        yield* Effect.addFinalizer(() => Effect.sync(() => workflowCalls.mockRestore()));
        const key = yield* ManagedGit.canonicalGitMutationKey(
          f.implementationMain + "/.git",
          f.implementationWorktree,
        );
        const semaphore = yield* sharedPermits.getMutationSemaphore(key);
        yield* workflow.withRepositoryPermit(
          "review-factory.shared",
          f.implementationWorktree,
          Effect.gen(function* () {
            expect(Option.isNone(yield* semaphore.withPermitsIfAvailable(1)(Effect.void))).toBe(
              true,
            );
          }),
        );
        const factory = yield* makePiProductionRuntime({
          environmentId: "environment",
          distributionDirectory: process.env.PI_REVIEW_TARGET_NATIVE_DIST!,
          agentDirectory: f.options.agentDirectory,
          nativeStateRoot: f.options.nativeStateRoot,
          stagingRoot: f.options.agentDirectory + "-factory-stage",
          protectedRoots: [...f.options.protectedRoots],
          memoryBytes: f.options.memoryBytes,
          cleanupDeadlineMs: f.options.cleanupDeadlineMs,
          maxInputTokens: f.options.maxInputTokens,
          maxOutputTokens: f.options.maxOutputTokens,
        }).pipe(
          Effect.provideService(GitRepositoryPermits, sharedPermits),
          Effect.provideService(PiModelCatalogue, {
            readFresh: f.options.readCatalogue.pipe(Effect.orDie),
            refresh: Effect.die("Unexpected factory refresh"),
          }),
          Effect.provideService(FetchHttpClient.Fetch, async () => {
            throw Error("Unexpected factory transport");
          }),
        );
        // Instance acquisition/preparation happen outside the supplying layer's context.
        const instance = yield* factory.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: {},
        });
        const operation = yield* instance.prepareOperation(
          {
            threadId: f.binding.threadId,
            kind: "initialize",
            operationId: f.request.initializeOperationId,
          },
          () => Effect.void,
        );
        expect(operation.operation.operationKind).toBe("initialize");
        expect(
          workflowCalls.mock.calls.some(
            ([operation, cwd]) => operation === "review.target" && cwd === f.implementationMain,
          ),
        ).toBe(true);
        expect(f.transports).toBe(0);
        const rows =
          yield* f.sql`SELECT status FROM project_team_pi_operation WHERE operation_id=${f.request.initializeOperationId}`;
        expect(rows).toEqual([expect.objectContaining({ status: "prepared" })]);
      }),
    ),
);

// Opt in with a Root-built distribution. This runs the actual owner, worker entry,
// SDK and report bridge; the transport below only replays deterministic SSE.
describe.runIf(Boolean(process.env.PI_REVIEW_TARGET_NATIVE_DIST))(
  "verified review target native regression",
  () => {
    for (const mode of [
      "mounted",
      "long-authorized-stream",
      "long-revoked-stream",
      "ack-authority-held",
      "assessed",
      "missing-descriptor",
      "mismatched-descriptor",
      "absent-mount",
      "path-alias",
      "unicode-alias",
    ] as const)
      it.effect(
        mode === "long-authorized-stream" || mode === "long-revoked-stream"
          ? `handles native reviewer ${mode} beyond the former request deadline`
          : mode === "ack-authority-held"
            ? "consumes native ACK receipts while the managed authority host is held"
            : mode === "mounted"
              ? "reads committed target bytes from an independent readonly reviewer and retains its report"
              : mode === "assessed"
                ? "assesses exact parent criteria after native reads and retains qualified joined progress"
                : `rejects actual native review reads with ${mode}`,
        () =>
          scoped(
            Effect.gen(function* () {
              const nativeFs = yield* FileSystem.FileSystem;
              const assessmentStage =
                mode === "assessed"
                  ? yield* nativeFs.makeTempDirectoryScoped({
                      directory: process.env.PI_REVIEW_TARGET_NATIVE_SCRATCH,
                    })
                  : undefined;
              const assessmentAssets = assessmentStage
                ? yield* preparePiRuntimeAssets({
                    distributionDirectory: process.env.PI_REVIEW_TARGET_NATIVE_DIST!,
                    stagingDirectory: assessmentStage,
                    protectedRoots: [
                      yield* nativeFs.makeTempDirectoryScoped({
                        directory: process.env.PI_REVIEW_TARGET_NATIVE_SCRATCH,
                      }),
                    ],
                  })
                : undefined;
              if (assessmentStage)
                yield* Effect.addFinalizer(() =>
                  nativeFs.chmod(assessmentStage, 0o700).pipe(Effect.orDie),
                );
              const f = yield* requiredReviewTransferFixture(
                true,
                assessmentAssets ? ownedReviewNativeAssets(assessmentAssets) : undefined,
              );
              const stageDirectory = yield* f.fs.makeTempDirectoryScoped(
                process.env.PI_REVIEW_TARGET_NATIVE_SCRATCH
                  ? { directory: process.env.PI_REVIEW_TARGET_NATIVE_SCRATCH }
                  : undefined,
              );
              const assets =
                assessmentAssets ??
                (yield* preparePiRuntimeAssets({
                  distributionDirectory: process.env.PI_REVIEW_TARGET_NATIVE_DIST!,
                  stagingDirectory: stageDirectory,
                  protectedRoots: [f.options.agentDirectory],
                }));
              yield* Effect.addFinalizer(() =>
                f.fs.chmod(stageDirectory, 0o700).pipe(Effect.orDie),
              );
              yield* f.fs.writeFileString(
                f.options.agentDirectory + "/auth.json",
                json({ "command-code": { type: "api_key", key: "synthetic-offline-review-key" } }),
              );
              const reads = [
                "README.md",
                "/review-target/README.md",
                "/review-target/greeting.js",
                "/review-target/greeting.test.js",
              ];
              const expected = [
                "base README\n",
                "implemented README\n",
                "export const greeting = 'hello';\n",
                "import { greeting } from './greeting.js';\nif (greeting !== 'hello') throw Error('wrong greeting');\n",
              ];
              const delayed = mode === "long-authorized-stream" || mode === "long-revoked-stream";
              const testClock = yield* TestClock.testClockWith(Effect.succeed);
              const advances = yield* Queue.unbounded<{
                revoke: boolean;
                resolve: () => void;
                reject: (cause: unknown) => void;
              }>();
              yield* Effect.gen(function* () {
                const advance = yield* Queue.take(advances);
                yield* Effect.gen(function* () {
                  yield* testClock.adjust(1000);
                  if (advance.revoke) {
                    const current = (yield* readCurrentState(
                      f.sql,
                      projectId,
                    )).foundationRecords?.find(
                      (entry) =>
                        entry.kind === "run-binding" && entry.recordId === f.binding.recordId,
                    );
                    if (current?.kind !== "run-binding")
                      return yield* Effect.die("Missing native reviewer binding");
                    yield* restoreHistoricalBinding({
                      ...current,
                      revision: current.revision + 1,
                      status: "revoked",
                    });
                  }
                  advance.resolve();
                }).pipe(Effect.catchCause((cause) => Effect.sync(() => advance.reject(cause))));
              }).pipe(Effect.forever, Effect.forkScoped);
              let virtualMillis = 0;
              let modelDeadlineMs = 0;
              let delayedRequest = false;
              let delayedForwards = 0;
              let delayedAcks = 0;
              let parentSignal: AbortSignal | undefined;
              let deadlineOnlyAbort = false;
              const deadlines: Array<{ at: number; controller: AbortController }> = [];
              if (delayed) {
                // Virtualize only the captured broker timer; native owner and parent timers stay real.
                const timeout = AbortSignal.timeout;
                const timerSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((millis) => {
                  if (millis !== modelDeadlineMs) return timeout(millis);
                  const controller = new AbortController();
                  deadlines.push({ at: virtualMillis + millis, controller });
                  return controller.signal;
                });
                yield* Effect.addFinalizer(() => Effect.sync(() => timerSpy.mockRestore()));
              }
              let calls = 0;
              let reportIntent = "";
              let reportCommandId = "";
              const observations: string[] = [];
              const reviewCriteria = (yield* readCurrentState(f.sql, projectId)).criteria.filter(
                (criterion) => criterion.taskId === f.binding.taskId && criterion.required,
              );
              let criterionAssessments: ProjectTeamReviewCriterionAssessment[] | undefined;
              const workerFailures: string[] = [];
              let ackAuthoritySignal: AbortSignal | undefined;
              let nativeAckReceipts = 0;
              let ackTerminal: SessionRuntime.PiSessionTerminal | undefined;
              let redundantAckAuthorityCalls = 0;
              if (mode === "ack-authority-held") {
                const originalOperations = PiOperations.makeProjectTeamPiOperations;
                const authoritySpy = vi
                  .spyOn(PiOperations, "makeProjectTeamPiOperations")
                  .mockImplementation((options) =>
                    originalOperations(options).pipe(
                      Effect.map((operations) => ({
                        ...operations,
                        authorize: (operation) =>
                          Effect.gen(function* () {
                            const signal = ackAuthoritySignal;
                            if (signal) {
                              redundantAckAuthorityCalls++;
                              yield* Effect.promise(
                                () =>
                                  new Promise<void>((resolve) => {
                                    if (signal.aborted) resolve();
                                    else
                                      signal.addEventListener("abort", () => resolve(), {
                                        once: true,
                                      });
                                  }),
                              );
                            }
                            return yield* operations.authorize(operation);
                          }),
                      })),
                    ),
                  );
                yield* Effect.addFinalizer(() => Effect.sync(() => authoritySpy.mockRestore()));
              }
              const originalSession = SessionRuntime.makePiSessionRuntime;
              const sessionSpy = vi
                .spyOn(SessionRuntime, "makePiSessionRuntime")
                .mockImplementation((input) => {
                  const target = input.bootstrap.resources?.reviewTarget;
                  if (delayed) modelDeadlineMs = input.broker.deadlineMs;
                  return originalSession({
                    ...input,
                    ...(delayed
                      ? {
                          broker: {
                            ...input.broker,
                            authorizeCurrent: async (
                              phase: Parameters<typeof input.broker.authorizeCurrent>[0],
                              signal: AbortSignal,
                            ) => {
                              if (
                                phase === "beforeForward" &&
                                delayedRequest &&
                                delayedForwards < 40
                              ) {
                                delayedForwards++;
                                await new Promise<void>((resolve, reject) => {
                                  Queue.offerUnsafe(advances, {
                                    revoke:
                                      mode === "long-revoked-stream" && delayedForwards === 10,
                                    resolve,
                                    reject,
                                  });
                                });
                                virtualMillis += 1000;
                                for (const deadline of deadlines)
                                  if (deadline.at <= virtualMillis) deadline.controller.abort();
                                if (signal.aborted && parentSignal && !parentSignal.aborted)
                                  deadlineOnlyAbort = true;
                              }
                              await input.broker.authorizeCurrent(phase, signal);
                            },
                          },
                        }
                      : {}),
                    ...(mode === "ack-authority-held" || delayed
                      ? {
                          persistTerminal: async (
                            terminal: SessionRuntime.PiSessionTerminal,
                            signal: AbortSignal,
                          ) => {
                            ackTerminal = terminal;
                            await input.persistTerminal(terminal, signal);
                          },
                        }
                      : {}),
                    ...(mode === "missing-descriptor"
                      ? {
                          bootstrap: {
                            ...input.bootstrap,
                            resources: { skills: input.bootstrap.resources?.skills ?? [] },
                          },
                        }
                      : mode === "mismatched-descriptor" && target
                        ? {
                            bootstrap: {
                              ...input.bootstrap,
                              resources: {
                                ...input.bootstrap.resources!,
                                reviewTarget: { ...target, ino: target.ino + 1 },
                              },
                            },
                          }
                        : {}),
                    onWorkerFrame: async (frame, signal) => {
                      parentSignal = signal;
                      if (delayed && frame.message.type === "ack" && frame.message.requestId === 2)
                        delayedAcks++;
                      if (frame.message.type === "worker-failure")
                        workerFailures.push(frame.message.code);
                      if (mode === "ack-authority-held" && frame.message.type === "ack") {
                        nativeAckReceipts++;
                        ackAuthoritySignal = signal;
                        try {
                          await input.onWorkerFrame?.(frame, signal);
                        } finally {
                          ackAuthoritySignal = undefined;
                        }
                      } else await input.onWorkerFrame?.(frame, signal);
                    },
                  });
                });
              yield* Effect.addFinalizer(() => Effect.sync(() => sessionSpy.mockRestore()));
              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
              const missingMountSpawner = ChildProcessSpawner.make((command) => {
                if (
                  mode !== "absent-mount" ||
                  command._tag !== "StandardCommand" ||
                  command.command !== "/usr/bin/systemd-run"
                )
                  return spawner.spawn(command);
                const args = [...command.args];
                const last = args.length - 1;
                const spec = decodeNativeJsonEvidence(
                  Buffer.from(args[last]!, "base64").toString("utf8"),
                );
                const { reviewTarget: _omitted, ...withoutTarget } = spec;
                args[last] = Buffer.from(json(withoutTarget)).toString("base64");
                return spawner.spawn({ ...command, args });
              });
              const runtime = yield* makePiManagedRuntimeLive({
                ...f.options,
                runtimeFiles: assets.runtimeFiles,
                workerArgv: (identity, operation) =>
                  assets.workerArgv(identity, operation, "/state/sessions"),
                memoryBytes: 536870912,
                cleanupDeadlineMs: 5000,
                maxInputTokens: 32000,
                maxOutputTokens: 512,
                revalidateRuntime: assets.revalidate.pipe(Effect.mapError(controlledCallbackError)),
                transport: async (_url, init) => {
                  const body = decodeReviewNativeRequest(init.body);
                  const reportSchema = body.tools.find(
                    (tool) => tool.function.name === "project_work_report",
                  );
                  if (!reportSchema) throw Error("Missing advertised native report schema");
                  const template = decodeNativeReportTemplate(
                    decodeNativeReportParameters(reportSchema.function.parameters).properties
                      .intentJSON.description,
                  );
                  if (typeof template.commandId !== "string")
                    throw Error("Missing advertised native report command");
                  reportCommandId = template.commandId;
                  reportIntent = json({
                    ...template,
                    outcome: "complete",
                    ...(criterionAssessments ? { criterionAssessments } : {}),
                    outputs: reviewCriteria.map((criterion) => ({
                      criterionId: criterion.criterionId,
                      kind: "observation",
                      detail:
                        "Independently read the committed README, greeting implementation and its test at the exact retained verification target.",
                    })),
                    summary:
                      "Read the exact committed README, greeting and test from the verified readonly target.",
                  });
                  const previous = body.messages.filter(
                    (message: { role: string }) => message.role === "tool",
                  );
                  for (
                    let index = observations.length;
                    index < Math.min(previous.length, reads.length);
                    index++
                  ) {
                    const content = decodeNativeReadOutput(String(previous[index]!.content))
                      .content.map((part) => part.text)
                      .join("");
                    expect(content).toBe(expected[index]!);
                    observations.push(content);
                  }
                  const index = calls++;
                  delayedRequest = delayed && index === 1;
                  const tool =
                    index < reads.length
                      ? {
                          name: "read",
                          args: {
                            path:
                              index === 1 && mode === "path-alias"
                                ? "@/review-target/README.md"
                                : index === 1 && mode === "unicode-alias"
                                  ? "/review-target/space\u00A0name.txt"
                                  : reads[index],
                          },
                        }
                      : index === reads.length
                        ? { name: "project_work_report", args: { intentJSON: reportIntent } }
                        : undefined;
                  const delta = tool
                    ? {
                        role: "assistant",
                        tool_calls: [
                          {
                            index: 0,
                            id: `review-call-${index}`,
                            type: "function",
                            function: { name: tool.name, arguments: json(tool.args) },
                          },
                        ],
                      }
                    : { role: "assistant", content: "Review recorded." };
                  const deltas =
                    delayedRequest && tool
                      ? [
                          {
                            role: "assistant",
                            tool_calls: [
                              {
                                index: 0,
                                id: `review-call-${index}`,
                                type: "function",
                                function: { name: tool.name, arguments: "" },
                              },
                            ],
                          },
                          ...Array.from(" ".repeat(48) + json(tool.args), (part) => ({
                            tool_calls: [{ index: 0, function: { arguments: part } }],
                          })),
                        ]
                      : [delta];
                  const streamText =
                    [
                      ...deltas.map((part) => ({
                        id: "offline-review",
                        model,
                        choices: [{ index: 0, delta: part, finish_reason: null }],
                      })),
                      {
                        id: "offline-review",
                        model,
                        choices: [
                          { index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" },
                        ],
                      },
                      {
                        model,
                        choices: [],
                        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
                      },
                    ]
                      .map((event) => `data: ${json(event)}\n\n`)
                      .join("") + "data: [DONE]\n\n";
                  let offset = 0;
                  return new Response(
                    delayedRequest
                      ? new ReadableStream<Uint8Array>({
                          pull(controller) {
                            if (offset === streamText.length) {
                              controller.close();
                              return;
                            }
                            controller.enqueue(
                              new TextEncoder().encode(streamText.slice(offset, offset + 8)),
                            );
                            offset = Math.min(streamText.length, offset + 8);
                          },
                        })
                      : streamText,
                    { headers: { "content-type": "text/event-stream" } },
                  );
                },
              }).pipe(
                Effect.provide(f.workflowLayer),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, missingMountSpawner),
              );
              const instance = yield* runtime.forInstance({
                instanceId: providerInstanceId,
                enabled: true,
                configuration: {},
              });
              const pi = yield* makeProjectTeamPiRuntime();
              const ownedAssets = ownedReviewNativeAssets(assets);
              yield* pi.publishAssets(providerInstanceId, ownedAssets, instance);
              let parentEvidenceId: string | undefined;
              let verificationJobId: string | undefined;
              const before =
                mode === "assessed" ? yield* f.reader.readRequired(f.snapshot) : undefined;
              const journal = yield* makeProjectTeamDispatchJournal({
                environmentId: "environment",
                maximumEnvironmentModelCalls: 4,
                verifyStage: (receipt) =>
                  receipt.evidence.bindingId === f.binding.recordId
                    ? Effect.void
                    : Effect.die("Foreign native review stage"),
              });
              let snapshot = f.snapshot;
              const advance = (
                stage: "workspace-ready" | "setup-complete" | "session-bound" | "assignment-intent",
              ) =>
                Effect.gen(function* () {
                  snapshot = yield* journal.readRetained(
                    (yield* journal.advanceStage(snapshot.fence, {
                      receiptId: `native-review-${stage}`,
                      stage,
                      evidence: { bindingId: f.binding.recordId },
                    })).fence.dispatchId,
                  );
                });
              yield* advance("workspace-ready");
              yield* advance("setup-complete");
              const initialized = yield* instance.prepareOperation(
                {
                  threadId: f.binding.threadId,
                  kind: "initialize",
                  operationId: f.request.initializeOperationId,
                },
                () => Effect.void,
              );
              const initialization = yield* initialized.run.pipe(Effect.result);
              if (mode === "mismatched-descriptor" || mode === "absent-mount") {
                expect(initialization._tag).toBe("Failure");
                expect(workerFailures.length > 0).toBe(true);
                expect(calls).toBe(0);
                return;
              }
              if (initialization._tag === "Failure")
                return yield* Effect.fail(initialization.failure);
              const initResult = initialization.success;
              expect(initResult.terminal.outcome).toBe("success");
              expect(initResult.terminal.drain?.kernel).toBe("removed");
              expect(calls).toBe(0);
              if (mode === "assessed") {
                const settings = yield* ServerSettings.ServerSettingsService;
                yield* settings.updateSettings({ projectTeamExecutionEnabled: true });
                if (!before) return yield* Effect.die("Missing assessed original context");
                verificationJobId = before.required.reviewTarget?.prepared.manifest.jobId;
                if (!verificationJobId)
                  return yield* Effect.die("Missing original assessed verification job");
                const host = yield* makeProjectWorkVerificationExecutionHost({
                  environmentId: "environment",
                  maximumEnvironmentModelCalls: 4,
                  protectedRoots: [f.options.agentDirectory, f.options.nativeStateRoot],
                  nativeAdmission: Effect.void,
                }).pipe(
                  Effect.provide(Layer.merge(f.workflowLayer, ProjectWorkEventBusLive)),
                  Effect.provideService(ProjectTeamPiRuntime, pi),
                );
                const verification = yield* makeProjectWorkVerificationExecution({
                  ...host,
                  environmentId: "environment",
                });
                yield* verification.sweep;
                const verified = yield* host.journal.readResult(verificationJobId);
                expect(verified).toMatchObject({
                  outcome: "success",
                  exitCode: 0,
                  outputComplete: true,
                  drain: { kernel: "removed", childExitCode: 0 },
                });
                if (!verified) return yield* Effect.die("Missing retained actual verifier result");
                const artifacts = yield* makeProjectWorkArtifacts({
                  environmentId: "environment",
                  maximumArtifactBytes: 4096,
                });
                for (const output of [verified.stdout, verified.stderr]) {
                  const retained = yield* artifacts.readRetained(output.artifactId);
                  if (!retained)
                    return yield* Effect.die("Missing retained actual verifier output");
                  const { bytes, ...receipt } = retained;
                  expect(receipt).toEqual(output);
                  expect(bytes.byteLength).toBe(0);
                }
                const parentState = yield* readCurrentState(f.sql, projectId);
                const evidence = parentState.evidence.find(
                  (entry) =>
                    entry.taskId === f.root.taskId &&
                    entry.kind === "test" &&
                    entry.detail &&
                    decodeNativeJsonEvidence(entry.detail).jobId === verificationJobId,
                );
                if (!evidence)
                  return yield* Effect.die(
                    "Missing actual retained successful verification evidence",
                  );
                const applicability = parentState.foundationRecords?.find(
                  (record) =>
                    record.kind === "evidence-applicability" &&
                    record.evidenceId === evidence.evidenceId,
                );
                const verifiedTarget = before.required.reviewTarget!.prepared.manifest.target;
                expect(applicability).toMatchObject({
                  kind: "evidence-applicability",
                  status: "current",
                  taskId: f.root.taskId,
                  evidenceId: evidence.evidenceId,
                  exitCode: 0,
                  repository: verifiedTarget.repository,
                  worktree: verifiedTarget.worktree,
                  testedCommit: verifiedTarget.testedCommit,
                  testedTree: verifiedTarget.testedTree,
                  artifactId: verified.stdout.artifactId,
                });
                parentEvidenceId = evidence.evidenceId;
                const selected = before.required.reviewTarget!.prepared.manifest.criteria;
                criterionAssessments = selected.map((criterion) => ({
                  criterionId: criterion.criterionId,
                  expectedRevision: criterion.revision,
                  verdict: "met",
                  detail:
                    "Independently read the exact committed files and retained successful greeting test result.",
                  evidenceIds: [evidence.evidenceId],
                }));
                expect(criterionAssessments.length).toBeGreaterThan(0);
                expect(
                  parentState.criteria
                    .filter(
                      (entry) =>
                        entry.taskId === f.root.taskId &&
                        selected.some((criterion) => criterion.criterionId === entry.criterionId),
                    )
                    .every((entry) => entry.status !== "satisfied"),
                ).toBe(true);
              }
              yield* advance("session-bound");
              yield* advance("assignment-intent");
              const assigned = yield* instance.prepareOperation(
                {
                  threadId: f.binding.threadId,
                  kind: "prompt",
                  operationId: f.request.assignmentOperationId,
                  prompt: f.request.assignment,
                  resumeCursor: initResult.session.resumeCursor,
                },
                () => Effect.void,
              );
              const assignment = yield* assigned.run.pipe(Effect.result);
              if (
                mode === "missing-descriptor" ||
                mode === "path-alias" ||
                mode === "unicode-alias"
              ) {
                expect(assignment._tag).toBe("Failure");
                expect(workerFailures.includes("TOOL_FAILURE")).toBe(true);
                expect(observations.length).toBe(1);
                expect(calls).toBe(2);
                expect(
                  (yield* f.sql`SELECT command_id FROM project_work_command_receipts WHERE command_id=${reportCommandId}`)
                    .length,
                ).toBe(0);
                const drains = yield* f.sql<{
                  kernel: string;
                }>`SELECT json_extract(drain_json,'$.kernel') AS kernel FROM project_team_pi_process WHERE operation_id=${f.request.assignmentOperationId}`;
                expect(drains[0]?.kernel).toBe("removed");
                expect(yield* f.fs.readFileString(f.implementationWorktree + "/README.md")).toBe(
                  expected[1],
                );
                return;
              }
              if (delayed) {
                const remaining =
                  f.snapshot.intent.limits.rootDeadlineAtMs - testClock.currentTimeMillisUnsafe();
                expect(remaining).toBeGreaterThan(200000);
                expect(calls).toBeGreaterThanOrEqual(2);
                expect(delayedAcks).toBeGreaterThanOrEqual(Math.min(delayedForwards - 1, 40));
                if (mode === "long-revoked-stream") {
                  expect(assignment._tag).toBe("Failure");
                  expect(deadlineOnlyAbort).toBe(false);
                  expect(ackTerminal).toMatchObject({
                    outcome: "failed",
                    failureCode: "AUTHORIZATION_REJECTED",
                    drain: { kernel: "removed" },
                  });
                  expect(virtualMillis).toBe(10000);
                  expect(observations).toEqual([expected[0]]);
                  return;
                }
                expect({
                  deadlineOnlyAbort,
                  failureCode: ackTerminal?.failureCode,
                  virtualMillis,
                  delayedAcks,
                }).toMatchObject({
                  deadlineOnlyAbort: false,
                  failureCode: undefined,
                  virtualMillis: 40000,
                });
                expect(delayedAcks).toBeGreaterThanOrEqual(40);
              }
              if (mode === "ack-authority-held") {
                expect(nativeAckReceipts).toBeGreaterThan(0);
                expect(ackTerminal).toMatchObject({
                  outcome: "success",
                  drain: { kernel: "removed", childExitCode: 0 },
                });
                expect(redundantAckAuthorityCalls).toBe(0);
              }
              if (assignment._tag === "Failure") return yield* Effect.fail(assignment.failure);
              const result = assignment.success;
              expect(result.terminal.outcome).toBe("success");
              expect(result.terminal.drain?.kernel).toBe("removed");
              expect(observations.length).toBe(reads.length);
              expect(calls).toBe(6);
              const processes = yield* f.sql<{
                operation_id: string;
                allocation_json: string;
                owner_json: string;
                drain_json: string;
                status: string;
              }>`SELECT operation_id,allocation_json,owner_json,drain_json,status FROM project_team_pi_process ORDER BY operation_id`;
              expect(processes.length).toBe(2);
              for (const row of processes) {
                const allocation = yield* decodeNativeAllocation(row.allocation_json);
                expect(allocation.launch.workspaceRoot).toBe(f.binding.worktree);
                expect(allocation.launch.workspaceAccess).toBe("readonly");
                expect(allocation.launch.reviewTarget?.source).toBe(f.implementationWorktree);
                expect(allocation.launch.reviewTarget?.target).toBe("/review-target");
              }
              const reports =
                yield* f.sql`SELECT command_id FROM project_work_command_receipts WHERE command_id=${reportCommandId}`;
              expect(reports.length).toBe(1);
              const proposals = yield* makeProjectTeamReviewCompletionProposals(() =>
                Effect.succeed(undefined),
              );
              const proposal = yield* f.sql.withTransaction(
                proposals.readRetained({
                  environmentId: "environment",
                  projectId,
                  commandId: reportCommandId,
                }),
              );
              if (!proposal)
                return yield* Effect.die("Missing actual retained reviewer report provenance");
              expect(proposal.manifest.provenance.dispatchId).toBe(f.request.dispatchId);
              expect(proposal.manifest.operation.operationId).toBe(f.request.assignmentOperationId);
              expect(proposal.manifest.target.headSha).toBe(
                f.implementationReceipt
                  ? process
                      .getBuiltinModule("child_process")
                      .execFileSync(
                        "/usr/bin/git",
                        ["-C", f.implementationWorktree, "rev-parse", "HEAD"],
                        { encoding: "utf8" },
                      )
                      .trim()
                  : "missing",
              );
              expect(proposal.manifest.prepared.sha256.length).toBe(64);
              const reconciliationServices = yield* Effect.context<
                FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
              >();
              const collectJoined = () =>
                Effect.forEach(processes, (row) =>
                  Effect.gen(function* () {
                    const allocation = yield* decodeNativeAllocation(row.allocation_json);
                    const owner = decodeNativeOwner(row.owner_json);
                    const reconciliation = yield* ManagedProcess.reconcilePiManagedProcess(
                      {
                        allocation,
                        activation: "owned",
                        owner,
                      },
                      { stop: true },
                    );
                    expect(reconciliation.state).toBe("drained");
                    expect(reconciliation.kernel).toBe("removed");
                    return decodeNativeJsonEvidence(
                      json({ operationId: row.operation_id, allocation, owner, reconciliation }),
                    );
                  }),
                );
              const currentTarget = yield* Effect.gen(function* () {
                return yield* makeProjectTeamReviewCurrentTarget({ environmentId: "environment" });
              }).pipe(
                Effect.provide(f.workflowLayer),
                Effect.provideService(ProjectTeamPiRuntime, pi),
              );
              let preparedTargetChecks = 0;
              let finalTargetChecks = 0;
              const observedCurrentTarget = {
                ...currentTarget,
                assertInTransaction: (
                  ...input: Parameters<typeof currentTarget.assertInTransaction>
                ) =>
                  currentTarget.assertInTransaction(...input).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        preparedTargetChecks++;
                      }),
                    ),
                  ),
                assertOriginalInTransaction: (
                  ...input: Parameters<typeof currentTarget.assertOriginalInTransaction>
                ) =>
                  currentTarget.assertOriginalInTransaction(...input).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        finalTargetChecks++;
                      }),
                    ),
                  ),
              };
              const completion = yield* Effect.gen(function* () {
                return yield* makeProjectTeamReviewCompletion({
                  environmentId: "environment",
                  maximumEnvironmentModelCalls: 4,
                });
              }).pipe(Effect.provideService(ProjectTeamReviewCurrentTarget, observedCurrentTarget));
              const settling = yield* makeProjectTeamDispatchJournal({
                environmentId: "environment",
                maximumEnvironmentModelCalls: 4,
                verifyStage: (receipt) =>
                  receipt.evidence.bindingId === f.binding.recordId
                    ? Effect.void
                    : Effect.die("Foreign native joined review"),
                prepareReviewCompletion: completion.prepare,
                ...(mode === "assessed"
                  ? { verifyReviewTarget: observedCurrentTarget.assertOriginalInTransaction }
                  : {}),
                verifySettlement: (receipt, original) =>
                  Effect.gen(function* () {
                    expect(original.fence.dispatchId).toBe(f.request.dispatchId);
                    expect(receipt.evidence.operations).toEqual(yield* collectJoined());
                  }).pipe(
                    Effect.provide(reconciliationServices),
                    Effect.mapError(
                      () =>
                        new ProjectTeamDispatchJournalError({
                          reason: "Actual native owner reconciliation changed",
                        }),
                    ),
                  ),
              });
              snapshot = yield* settling.readRetained(
                (yield* settling.advanceStage(snapshot.fence, {
                  receiptId: "native-review-observed",
                  stage: "assignment-observed",
                  evidence: { bindingId: f.binding.recordId },
                })).fence.dispatchId,
              );
              const joined: DispatchJournal.ProjectTeamDispatchStageReceipt = {
                receiptId: "native-review-joined",
                stage: "settled",
                evidence: {
                  version: 1,
                  dispatchId: f.request.dispatchId,
                  bindingId: f.binding.recordId,
                  generation: f.binding.generation,
                  claimGeneration: snapshot.fence.claimGeneration,
                  operations: yield* collectJoined(),
                },
              };
              const settled = yield* mode === "assessed"
                ? currentTarget.withOriginalTarget(
                    snapshot,
                    joined,
                    settling.settleAfterJoined(snapshot.fence, joined),
                  )
                : settling.settleAfterJoined(snapshot.fence, joined);
              expect(settled.fence.stage).toBe("settled");
              const completed = yield* readCurrentState(f.sql, projectId);
              expect(completed.tasks.find((task) => task.taskId === f.binding.taskId)?.state).toBe(
                "completed",
              );
              expect(completed.tasks.find((task) => task.taskId === f.root.taskId)?.state).toBe(
                "ready",
              );

              if (mode === "assessed") {
                expect(preparedTargetChecks).toBeGreaterThan(0);
                expect(finalTargetChecks).toBeGreaterThan(0);
                if (proposal.manifest.report.type !== "project-team.assignment.report")
                  return yield* Effect.die("Unexpected native report type");
                expect(proposal.manifest.report.criterionAssessments).toEqual(criterionAssessments);
                expect(proposal.manifest.criterionAssessments?.length).toBe(
                  criterionAssessments!.length,
                );
                for (const assessment of criterionAssessments!) {
                  const criterion = completed.criteria.find(
                    (entry) => entry.criterionId === assessment.criterionId,
                  );
                  expect(criterion).toMatchObject({
                    taskId: f.root.taskId,
                    status: "satisfied",
                    revision: assessment.expectedRevision + 1,
                  });
                  const progress = completed.evidence.find(
                    (entry) =>
                      entry.taskId === f.root.taskId &&
                      entry.criterionId === assessment.criterionId &&
                      entry.evidenceId.startsWith("review-criterion-progress:"),
                  );
                  if (!progress?.detail)
                    return yield* Effect.die(
                      "Missing retained parent criterion assessment evidence",
                    );
                  expect(criterion?.satisfiedByEvidenceIds).toContain(progress.evidenceId);
                  const provenance = decodeNativeJsonEvidence(progress.detail);
                  expect(provenance).toMatchObject({
                    kind: "project-team.review-criterion-progress",
                    proposalCommandId: reportCommandId,
                    assignmentOperationId: f.request.assignmentOperationId,
                    joinedReceiptId: joined.receiptId,
                    target: proposal.manifest.target,
                    verification: {
                      jobId: verificationJobId,
                      outcome: "success",
                      exitCode: 0,
                      evidenceId: parentEvidenceId,
                    },
                    assessment: {
                      verdict: "met",
                      originalRevision: assessment.expectedRevision,
                      evidence: [expect.objectContaining({ id: parentEvidenceId })],
                    },
                    criterionChange: { revision: criterion!.revision },
                  });
                }
              }
              const freshness = yield* f.sql<{
                native_jsonl: string;
                manifest_json: string;
              }>`SELECT native_jsonl,manifest_json FROM project_team_review_freshness`;
              expect(freshness.length).toBe(1);
              expect(
                freshness[0]!.native_jsonl.includes(
                  "Verified review files: /review-target/<relative-file>",
                ),
              ).toBe(true);
              expect(freshness[0]!.native_jsonl.includes('"cwd":"/workspace"')).toBe(true);
              const initialContext = freshness[0]!.native_jsonl
                .trim()
                .split("\n")
                .map((line) => decodeNativeJsonEvidence(line))
                .find((entry) => entry.customType === "t3-approved-initial-context");
              const data = initialContext?.data;
              if (
                !data ||
                typeof data !== "object" ||
                Array.isArray(data) ||
                !("text" in data) ||
                typeof data.text !== "string"
              )
                return yield* Effect.die("Missing actual native approved briefing");
              const target = (yield* decodeNativeAllocation(processes[0]!.allocation_json)).launch
                .reviewTarget;
              if (!target) return yield* Effect.die("Missing retained mounted target");
              expect(
                data.text.includes(
                  `tested commit ${target.testedCommit}; tested tree ${target.testedTree}`,
                ),
              ).toBe(true);
              expect(NodeCrypto.createHash("sha256").update(data.text).digest("hex")).toBe(
                proposal.manifest.freshness.briefingSHA256,
              );
              expect(decodeNativeJsonEvidence(freshness[0]!.manifest_json).briefingSHA256).toBe(
                proposal.manifest.freshness.briefingSHA256,
              );
              expect(yield* f.fs.readFileString(f.binding.worktree + "/README.md")).toBe(
                expected[0],
              );
              for (let index = 1; index < reads.length; index++)
                expect(
                  yield* f.fs.readFileString(
                    f.implementationWorktree + reads[index]!.slice("/review-target".length),
                  ),
                ).toBe(expected[index]);
            }),
          ),
        120_000,
      );
  },
);

for (const mutation of ["dirty", "untracked", "ignored", "new-commit", "root-replaced"] as const)
  it.effect(`rejects a ${mutation} verified review target before allocation`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* requiredReviewTransferFixture();
        const root = f.implementationWorktree;
        if (mutation === "dirty")
          yield* f.fs.writeFileString(root + "/README.md", "unverified change\n");
        if (mutation === "untracked")
          yield* f.fs.writeFileString(root + "/untracked.txt", "unverified\n");
        if (mutation === "ignored") {
          yield* f.fs.writeFileString(root + "/.ignored", "unverified\n");
          yield* f.fs.writeFileString(f.implementationMain + "/.git/info/exclude", ".ignored\n");
        }
        if (mutation === "new-commit")
          yield* Effect.sync(() =>
            process
              .getBuiltinModule("child_process")
              .execFileSync(
                "/usr/bin/git",
                [
                  "-C",
                  root,
                  "-c",
                  "user.name=Fixture",
                  "-c",
                  "user.email=fixture@example.test",
                  "commit",
                  "--allow-empty",
                  "-qm",
                  "unverified head",
                ],
                { stdio: "ignore" },
              ),
          );
        if (mutation === "root-replaced")
          yield* Effect.promise(async () => {
            const fs = process.getBuiltinModule("fs").promises;
            await fs.rename(root, root + "-original");
            await fs.cp(root + "-original", root, { recursive: true });
          });
        const result = yield* f.instance
          .prepareOperation(
            {
              threadId: f.binding.threadId,
              kind: "initialize",
              operationId: f.request.initializeOperationId,
            },
            () => Effect.void,
          )
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(f.allocations).toBe(0);
        expect((yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).length).toBe(0);
      }),
    ),
  );

for (const phase of [
  "beforeAcquire",
  "beforeStart",
  "beforeToolInvoke",
  "beforeToolReturn",
] as const)
  it.effect(`rechecks physical review target at ${phase}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* requiredReviewTransferFixture();
        yield* initializeRequiredContext(f);
        let captured: SessionRuntime.PiSessionRuntimeOptions | undefined;
        const original = SessionRuntime.makePiSessionRuntime;
        const spy = vi.spyOn(SessionRuntime, "makePiSessionRuntime").mockImplementation((input) => {
          captured = input;
          return original(input);
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        yield* f.instance.prepareOperation(
          {
            threadId: f.binding.threadId,
            kind: "prompt",
            operationId: f.request.assignmentOperationId,
            prompt: f.request.assignment,
          },
          () => Effect.void,
        );
        if (!captured) return yield* Effect.die("Missing real prepared session boundary");
        const input = captured;
        const authorize = () =>
          input.authorizeCurrent(
            {
              phase,
              identity: input.identity,
              operation: input.operation,
              ...(["beforeToolInvoke", "beforeToolReturn"].includes(phase)
                ? { tool: { name: "read", capability: "pi.read", execution: "local" as const } }
                : {}),
            },
            new AbortController().signal,
          );
        yield* Effect.promise(authorize);
        yield* f.fs.writeFileString(
          f.implementationWorktree + "/README.md",
          "changed after preparation\n",
        );
        const denied = yield* Effect.promise(() =>
          authorize().then(
            () => false,
            () => true,
          ),
        );
        expect(denied).toBe(true);
        yield* f.instance.requestStop(f.binding.threadId);
      }),
    ),
  );

for (const mutation of ["absent", "hash", "manifest", "tree", "commit", "foreign-source"] as const)
  it.effect(`retained allocation rejects ${mutation} review identity`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* requiredReviewTransferFixture();
        const original = ManagedProcess.preallocatePiManagedProcess;
        const spy = vi
          .spyOn(ManagedProcess, "preallocatePiManagedProcess")
          .mockImplementation((launch) => {
            const target = launch.reviewTarget;
            if (!target) return Effect.die("Missing physical review launch descriptor");
            return original({
              ...launch,
              reviewTarget:
                mutation === "absent"
                  ? undefined
                  : {
                      ...target,
                      ...(mutation === "hash" ? { targetHash: "0".repeat(64) } : {}),
                      ...(mutation === "manifest" ? { manifestHash: "0".repeat(64) } : {}),
                      ...(mutation === "tree" ? { testedTree: "0".repeat(40) } : {}),
                      ...(mutation === "commit" ? { testedCommit: "0".repeat(40) } : {}),
                      ...(mutation === "foreign-source"
                        ? { source: f.options.agentDirectory }
                        : {}),
                    },
            });
          });
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        expect(
          (yield* f.instance
            .prepareOperation(
              {
                threadId: f.binding.threadId,
                kind: "initialize",
                operationId: f.request.initializeOperationId,
              },
              () => Effect.void,
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect((yield* f.sql`SELECT operation_id FROM project_team_pi_operation`).length).toBe(0);
      }),
    ),
  );

it.effect(
  "keeps the production trusted Git ownership guard before native review target access",
  () =>
    scoped(
      Effect.gen(function* () {
        const fs = process.getBuiltinModule("fs");
        const original = fs.lstatSync;
        const spy = vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
          const stat = original(...args);
          if (args[0] === "/usr/bin/git" && stat)
            Object.defineProperty(stat, "uid", { value: 65534n });
          return stat;
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        const result = yield* ManagedGit.make({
          assignment: {
            effectId: "guard",
            runId: "guard",
            generation: 1,
            primaryRoot: "/guard-primary",
            commonGitDirectory: "/guard-primary/.git",
            worktreePath: "/guard-worktree",
            branchRef: "refs/heads/guard",
            baseRef: "refs/heads/main",
            baseOid: "a".repeat(40),
            ownershipToken: "guard",
            policyHash: "a".repeat(64),
          },
          revalidate: Effect.void,
          persistWorkspace: () => Effect.die("Untrusted binary cannot persist a workspace"),
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure.detail).toBe("Trusted Git executable is unavailable.");
      }),
    ),
);

for (const boundary of ["prepare", "run"] as const)
  for (const mutation of ["dirty", "root-replaced", "receipt-removed", "commit-changed"] as const)
    it.effect(`reviewer initialize replay rejects ${mutation} target at ${boundary}`, () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* requiredReviewTransferFixture();
          yield* initializeRequiredContext(f);
          const request = {
            threadId: f.binding.threadId,
            kind: "initialize" as const,
            operationId: f.request.initializeOperationId,
          };
          const noEmission = () => Effect.die("Unexpected reviewer replay emission");
          const stable = yield* f.instance.prepareOperation(request, noEmission);
          expect((yield* stable.run).terminal.outcome).toBe("success");
          const allocations = f.allocations;
          const rows =
            yield* f.sql`SELECT operation_id,status,terminal_json FROM project_team_pi_operation`;
          const root = f.implementationWorktree;
          if (mutation === "dirty")
            yield* f.fs.writeFileString(root + "/README.md", "unverified replay mutation\n");
          if (mutation === "root-replaced")
            yield* Effect.promise(async () => {
              const fs = process.getBuiltinModule("fs").promises;
              await fs.rename(root, root + "-original");
              await fs.cp(root + "-original", root, { recursive: true });
            });
          if (mutation === "commit-changed")
            yield* Effect.sync(() =>
              process
                .getBuiltinModule("child_process")
                .execFileSync(
                  "/usr/bin/git",
                  [
                    "-C",
                    root,
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.test",
                    "commit",
                    "--allow-empty",
                    "-qm",
                    "unreviewed replay head",
                  ],
                  { stdio: "ignore" },
                ),
            );
          if (mutation === "receipt-removed")
            yield* f.sql`DELETE FROM project_team_workspace_receipt WHERE binding_id=${f.root.bindingId}`;
          const result = yield* (
            boundary === "run"
              ? stable.run
              : f.instance
                  .prepareOperation(request, noEmission)
                  .pipe(Effect.flatMap((replay) => replay.run))
          ).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          expect(f.allocations).toBe(allocations);
          expect(f.transports).toBe(0);
          expect(
            yield* f.sql`SELECT operation_id,status,terminal_json FROM project_team_pi_operation`,
          ).toEqual(rows);
        }),
      ),
    );

it.effect(
  "reviewer replay acquires its repository permit before SQL and fences inherited reads",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* requiredReviewTransferFixture();
        yield* initializeRequiredContext(f);
        let permits = 0;
        const workflow = Layer.mock(GitWorkflowService, {
          withRepositoryPermit: (operation, _cwd, use) =>
            Effect.gen(function* () {
              if (operation === "review.replay") {
                expect(Option.isNone(yield* Effect.serviceOption(f.sql.transactionService))).toBe(
                  true,
                );
                permits++;
              }
              return yield* use;
            }),
        });
        const runtime = yield* makePiManagedRuntimeLive(f.options).pipe(Effect.provide(workflow));
        const instance = yield* runtime.forInstance({
          instanceId: providerInstanceId,
          enabled: true,
          configuration: {},
        });
        const request = {
          threadId: f.binding.threadId,
          kind: "initialize" as const,
          operationId: f.request.initializeOperationId,
        };
        const replay = yield* instance.prepareOperation(request, () =>
          Effect.die("Unexpected replay emission"),
        );
        expect((yield* replay.run).terminal.outcome).toBe("success");
        expect(permits).toBeGreaterThan(0);
        const operations = yield* makeProjectTeamPiOperations({
          environmentId: "environment",
        }).pipe(Effect.provide(workflow));
        const rows = yield* f.sql<{
          request_hash: string;
          intent_json: string;
        }>`SELECT request_hash,intent_json FROM project_team_pi_operation WHERE operation_id=${request.operationId}`;
        const row = rows[0];
        if (!row) return yield* Effect.die("Missing original reviewer replay operation");
        const resourceHash = decodeNativeJsonEvidence(row.intent_json).resourceHash;
        if (typeof resourceHash !== "string")
          return yield* Effect.die("Missing original reviewer replay resource identity");
        const before = permits;
        const inherited = () =>
          f.sql.withTransaction(
            operations.lookupInTransaction(
              { providerInstanceId, threadId: f.binding.threadId },
              request,
              row.request_hash,
              resourceHash,
            ),
          );
        expect((yield* inherited())?.terminal.outcome).toBe("success");
        expect(permits).toBe(before);
        yield* f.fs.writeFileString(
          f.implementationWorktree + "/README.md",
          "unverified inherited replay\n",
        );
        expect((yield* inherited().pipe(Effect.result))._tag).toBe("Failure");
        expect(permits).toBe(before);
        expect(f.transports).toBe(0);
      }),
    ),
);

for (const boundary of ["fresh", "replay-prepare", "replay-run"] as const)
  it.effect(`schema-encoded review workspace receipt permits ${boundary}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* requiredReviewTransferFixture();
        const receipt = f.implementationReceipt;
        if (!receipt) return yield* Effect.die("Missing physical implementation receipt");
        const rows = yield* f.sql<{
          receipt_json: string;
          assignment_json: string;
        }>`SELECT receipt_json,assignment_json FROM project_team_workspace_receipt WHERE binding_id=${f.root.bindingId}`;
        expect(rows.length).toBe(1);
        expect(rows[0]?.receipt_json).toBe(encodeFixtureWorkspaceReceipt(receipt));
        expect(rows[0]?.receipt_json).not.toBe(canonicalProjectWorkPayload(receipt));
        expect(rows[0]?.assignment_json).toBe(canonicalProjectWorkPayload(receipt.assignment));
        const required = yield* f.reader.readRequired(f.snapshot);
        expect(required.required.reviewTarget?.prepared.manifest.workspaceReceiptHash).toBe(
          NodeCrypto.createHash("sha256")
            .update(canonicalProjectWorkPayload(receipt))
            .digest("hex"),
        );
        yield* initializeRequiredContext(f);
        const allocations = f.allocations;
        if (boundary !== "fresh") {
          const replay = yield* f.instance.prepareOperation(
            {
              threadId: f.binding.threadId,
              kind: "initialize",
              operationId: f.request.initializeOperationId,
            },
            () => Effect.die("Unexpected schema receipt replay emission"),
          );
          if (boundary === "replay-run")
            expect((yield* replay.run).terminal.outcome).toBe("success");
        }
        expect(f.allocations).toBe(allocations);
        expect(f.transports).toBe(0);
      }),
    ),
  );

for (const boundary of ["fresh", "replay-prepare", "replay-run"] as const)
  for (const mutation of ["semantic", "assignment", "invalid", "excess"] as const)
    it.effect(`schema-encoded review workspace receipt denies ${mutation} at ${boundary}`, () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* requiredReviewTransferFixture();
          const receipt = f.implementationReceipt;
          if (!receipt) return yield* Effect.die("Missing physical implementation receipt");
          const request = {
            threadId: f.binding.threadId,
            kind: "initialize" as const,
            operationId: f.request.initializeOperationId,
          };
          if (boundary !== "fresh") yield* initializeRequiredContext(f);
          const prepared =
            boundary === "replay-run"
              ? yield* f.instance.prepareOperation(request, () =>
                  Effect.die("Unexpected invalid receipt replay emission"),
                )
              : undefined;
          const encoded =
            mutation === "semantic"
              ? encodeFixtureWorkspaceReceipt({ ...receipt, initialHeadOid: "0".repeat(40) })
              : mutation === "assignment"
                ? encodeFixtureWorkspaceReceipt({
                    ...receipt,
                    assignment: { ...receipt.assignment, ownershipToken: "changed-receipt-owner" },
                  })
                : mutation === "invalid"
                  ? json({ ...receipt, initialHeadOid: 42 })
                  : json({ ...receipt, unexpected: "denied" });
          const retained = yield* f.sql<{
            dispatch_id: string;
            environment_id: string;
            binding_id: string;
            generation: number;
            claim_generation: number;
            assignment_json: string;
          }>`SELECT dispatch_id,environment_id,binding_id,generation,claim_generation,assignment_json FROM project_team_workspace_receipt WHERE binding_id=${f.root.bindingId}`;
          const row = retained[0];
          if (retained.length !== 1 || !row)
            return yield* Effect.die("Missing original workspace receipt owner");
          // The retained row rejects UPDATE. Reinsert malformed/corrupt storage
          // in this disposable database without weakening that production trigger.
          yield* f.sql`DELETE FROM project_team_workspace_receipt WHERE dispatch_id=${row.dispatch_id}`;
          yield* f.sql`INSERT INTO project_team_workspace_receipt VALUES (${row.dispatch_id},${row.environment_id},${row.binding_id},${row.generation},${row.claim_generation},${row.assignment_json},${encoded})`;
          const allocations = f.allocations;
          const result = yield* (
            prepared
              ? prepared.run.pipe(Effect.asVoid)
              : f.instance
                  .prepareOperation(request, () =>
                    Effect.die("Unexpected invalid receipt emission"),
                  )
                  .pipe(Effect.asVoid)
          ).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          expect(f.allocations).toBe(allocations);
          expect(f.transports).toBe(0);
        }),
      ),
    );
