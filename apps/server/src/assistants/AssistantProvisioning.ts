import {
  CommandId,
  AssistantProvisioning as ProvisioningState,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as ManagedFolders from "../project/ManagedProjectFolders.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Repository from "./AssistantRepository.ts";
import { AssistantError, type AssistantRecord } from "./AssistantRepository.ts";

const isAssistantError = Schema.is(AssistantError);
const isProvisioning = Schema.is(ProvisioningState);
const provisioningStages = [
  "pending",
  "folder",
  "repository",
  "project",
  "thread",
  "checkpoint",
] as const;
const retainedStage = (record: AssistantRecord) =>
  record.provisioningStage ??
  (isProvisioning(record.detail.provisioning) && record.detail.provisioning.state === "provisioning"
    ? record.detail.provisioning.stage
    : "pending");
const threadMatches = (
  record: AssistantRecord,
  thread: Pick<OrchestrationV2AppThread, "id" | "projectId" | "worktreePath" | "archivedAt">,
) =>
  thread.id === record.detail.summary.binding.canonicalThreadId &&
  thread.projectId === record.detail.summary.binding.backingProjectId &&
  thread.archivedAt === null &&
  (thread.worktreePath === null || thread.worktreePath === record.workspaceRoot);
const repairReason =
  "The canonical workspace or conversation is missing, archived, or changed. Restore it explicitly; retained history and memory remain available.";
export class AssistantProvisioning extends Context.Service<
  AssistantProvisioning,
  {
    readonly ensure: (record: AssistantRecord) => Effect.Effect<AssistantRecord, AssistantError>;
    readonly reconcile: (
      record: AssistantRecord,
      options?: { readonly repair: boolean },
    ) => Effect.Effect<AssistantRecord, AssistantError>;
  }
>()("t3/assistants/AssistantProvisioning") {}
const make = Effect.gen(function* () {
  const repository = yield* Repository.AssistantRepository;
  const folders = yield* ManagedFolders.ManagedProjectFolders;
  const projects = yield* Projects.ProjectService;
  const launch = yield* Launch.ThreadLaunchService;
  const threads = yield* Threads.ThreadManagementService;
  const locks = yield* KeyedLock.make<string>();
  const validateTarget = Effect.fn("AssistantProvisioning.validateTarget")(function* (
    record: AssistantRecord,
    required: "partial" | "repository" | "project" | "thread",
  ) {
    const binding = record.detail.summary.binding;
    const project = yield* projects.getById(binding.backingProjectId, { includeDeleted: true });
    const thread = yield* threads.getThreadShell(binding.canonicalThreadId);
    if (
      ((required === "project" || required === "thread") && Option.isNone(project)) ||
      (required === "thread" && !thread) ||
      (Option.isSome(project) &&
        (project.value.deletedAt !== null ||
          project.value.id !== binding.backingProjectId ||
          project.value.workspaceRoot !== record.workspaceRoot)) ||
      (thread && (!threadMatches(record, thread) || Option.isNone(project)))
    )
      return yield* new AssistantError({ reason: "needs-repair" });
    if (record.workspaceRoot !== null) {
      yield* folders
        .validateAssistantRepository({
          assistantId: binding.assistantId,
          workspaceRoot: record.workspaceRoot,
        })
        .pipe(Effect.mapError((cause) => new AssistantError({ reason: "needs-repair", cause })));
    } else if (required !== "partial" || Option.isSome(project) || thread)
      return yield* new AssistantError({ reason: "needs-repair" });
    return { project, thread };
  });
  const pause = Effect.fn("AssistantProvisioning.pause")(function* (record: AssistantRecord) {
    return yield* repository.setProvisioning(record.detail.summary, {
      state: "needs-repair",
      binding: record.detail.summary.binding,
      reason: repairReason,
    });
  });
  const reconcile = Effect.fn("AssistantProvisioning.reconcile")(
    function* (input: AssistantRecord, options?: { readonly repair: boolean }) {
      const record = yield* repository.get(input.detail.summary);
      if (
        record.detail.summary.provisioningState !== "ready" &&
        !(options?.repair && record.detail.summary.provisioningState === "needs-repair")
      )
        return record;
      const result = yield* validateTarget(record, "thread").pipe(Effect.result);
      if (result._tag === "Failure") {
        if (isAssistantError(result.failure) && result.failure.reason === "needs-repair")
          return yield* pause(record);
        return yield* result.failure;
      }
      return options?.repair
        ? yield* repository.setProvisioning(
            record.detail.summary,
            {
              state: "ready",
              binding: record.detail.summary.binding,
            },
            undefined,
            { repair: true },
          )
        : record;
    },
    Effect.mapError((cause) =>
      isAssistantError(cause) ? cause : new AssistantError({ reason: "unavailable", cause }),
    ),
  );
  const ensure = Effect.fn("AssistantProvisioning.ensure")(function* (input: AssistantRecord) {
    return yield* locks.withLock(
      input.detail.summary.assistantId,
      Effect.gen(function* () {
        let record = yield* repository.get(input.detail.summary);
        const scope = record.detail.summary;
        const binding = scope.binding;
        if (scope.provisioningState === "ready") return yield* reconcile(record);
        if (scope.provisioningState === "needs-repair")
          return yield* new AssistantError({ reason: "needs-repair" });
        const prepare = Effect.gen(function* () {
          const stageIndex = provisioningStages.indexOf(retainedStage(record));
          yield* validateTarget(
            record,
            stageIndex >= 4
              ? "thread"
              : stageIndex >= 3
                ? "project"
                : record.workspaceRoot !== null
                  ? "repository"
                  : "partial",
          );
          if (record.workspaceRoot === null) {
            yield* repository.setProvisioning(scope, {
              state: "provisioning",
              stage: "folder",
              binding,
            });
            const folder = yield* folders.ensureAssistantRepository({
              assistantId: scope.assistantId,
            });
            record = yield* repository.setProvisioning(
              scope,
              { state: "provisioning", stage: "repository", binding },
              folder.workspaceRoot,
            );
          }
          let target = yield* validateTarget(record, "repository");
          if (Option.isNone(target.project)) {
            yield* projects.create({
              commandId: CommandId.make(`assistant-project:${scope.assistantId}`),
              projectId: binding.backingProjectId,
              title: `Assistant workspace: ${record.detail.summary.name}`,
              workspaceRoot: record.workspaceRoot!,
            });
            target = yield* validateTarget(record, "project");
          }
          record = yield* repository.setProvisioning(scope, {
            state: "provisioning",
            stage: "project",
            binding,
          });
          if (!target.thread) {
            const configuration = record.detail.configuration.configuration;
            const accepted = yield* launch.launch({
              commandId: CommandId.make(`assistant-home:${scope.assistantId}`),
              threadId: binding.canonicalThreadId,
              projectId: binding.backingProjectId,
              title: configuration.name,
              modelSelection: configuration.modelSelection,
              runtimeMode: configuration.runtimeMode,
              interactionMode: configuration.interactionMode,
              workspaceStrategy: { type: "root" },
              createdBy: "system",
              creationSource: "server",
            });
            if (
              accepted.threadId !== binding.canonicalThreadId ||
              !threadMatches(record, accepted.projection.thread) ||
              accepted.projection.thread.deletedAt !== null
            )
              return yield* new AssistantError({ reason: "needs-repair" });
          }
          yield* validateTarget(record, "thread");
          record = yield* repository.setProvisioning(scope, {
            state: "provisioning",
            stage: "thread",
            binding,
          });
          record = yield* repository.setProvisioning(scope, {
            state: "provisioning",
            stage: "checkpoint",
            binding,
          });
          // The receipt may have replayed; only the current retained home can become ready.
          yield* validateTarget(record, "thread");
          return yield* repository.setProvisioning(scope, { state: "ready", binding });
        });
        return yield* prepare.pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              if (isAssistantError(cause) && cause.reason === "needs-repair") yield* pause(record);
              else
                yield* repository.setProvisioning(scope, {
                  state: "failed",
                  binding,
                  retryable: true,
                  reason:
                    "Assistant setup failed. Verify Git is installed and the managed workspace is accessible, then retry provisioning.",
                });
              return yield* isAssistantError(cause)
                ? cause
                : new AssistantError({ reason: "unavailable", cause });
            }),
          ),
        );
      }),
    );
  });
  return AssistantProvisioning.of({ ensure, reconcile });
});
export const layer = Layer.effect(AssistantProvisioning, make);
