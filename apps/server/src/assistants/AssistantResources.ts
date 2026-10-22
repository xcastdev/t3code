import { SkillCatalogService } from "../skills/SkillCatalogService.ts";
import * as Schema from "effect/Schema";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  type OrchestrationV2InstructionSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AssistantError, type AssistantRecord } from "./AssistantRepository.ts";
import { ResourceInstructionComposition } from "../orchestration-v2/ResourceInstructionComposition.ts";
import { ManagedTextResourceCatalogService } from "../managedTextResources/ManagedTextResourceCatalogService.ts";

export const assistantMemoryContextHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");

export const assistantConfigurationHash = (record: AssistantRecord) =>
  NodeCrypto.createHash("sha256")
    .update(canonicalProjectWorkPayload(record.detail.configuration))
    .digest("hex");

export class AssistantInstructionEpoch extends Context.Service<
  AssistantInstructionEpoch,
  {
    readonly context: (
      record: AssistantRecord,
    ) => Effect.Effect<{ memoryEpoch: number; text: string }, AssistantError>;
  }
>()("t3/assistants/AssistantResources/AssistantInstructionEpoch") {}

export class AssistantResources extends Context.Service<
  AssistantResources,
  {
    readonly prepare: (
      record: AssistantRecord,
      threadId?: ThreadId,
    ) => Effect.Effect<OrchestrationV2InstructionSnapshot, AssistantError>;
  }
>()("t3/assistants/AssistantResources") {}

const isAssistantError = Schema.is(AssistantError);
const make = Effect.gen(function* () {
  const composition = yield* Effect.serviceOption(ResourceInstructionComposition);
  const epoch = yield* Effect.serviceOption(AssistantInstructionEpoch);
  const skills = yield* Effect.serviceOption(SkillCatalogService);
  const texts = yield* Effect.serviceOption(ManagedTextResourceCatalogService);
  return AssistantResources.of({
    prepare: Effect.fn("AssistantResources.prepare")(
      function* (record, threadId) {
        const { configuration, revision } = record.detail.configuration;
        const binding = record.detail.summary.binding;
        if (record.workspaceRoot === null)
          return yield* new AssistantError({ reason: "needs-repair" });
        const memory =
          (threadId === undefined || threadId === binding.canonicalThreadId) && Option.isSome(epoch)
            ? yield* epoch.value.context(record)
            : { memoryEpoch: 0, text: "" };
        const skillKeys: string[] = [];
        for (const selected of configuration.resources.skills) {
          if (Option.isNone(skills)) return yield* new AssistantError({ reason: "unavailable" });
          const detail = yield* skills.value.content(selected.skillId, record.workspaceRoot);
          skillKeys.push(detail.content.key);
          if (
            detail.metadata.revision.hash !== selected.revision.hash ||
            detail.metadata.revision.revision !== selected.revision.revision
          )
            return yield* new AssistantError({
              reason: "conflict",
              cause: "Selected skill revision changed.",
            });
        }
        const bodies: string[] = [
          configuration.rules,
          configuration.prompt,
          configuration.personality,
          ...(memory.text.length === 0 ? [] : [`Current retained memory:\n${memory.text}`]),
        ];
        if (configuration.resources.instructions.length > 0) {
          if (Option.isNone(texts))
            return yield* new AssistantError({
              reason: "unavailable",
              cause: "Instruction catalog unavailable.",
            });
          const scope = {
            environmentId: binding.environmentId,
            projectId: binding.backingProjectId,
            projectRoot: record.workspaceRoot,
            threadId: binding.canonicalThreadId,
          };
          const entries = yield* texts.value.list(scope);
          for (const selected of configuration.resources.instructions) {
            const entry = entries.entries.find(
              (value) =>
                value.id === selected.resourceId &&
                value.revision === selected.revision &&
                value.effective,
            );
            if (entry === undefined)
              return yield* new AssistantError({
                reason: "conflict",
                cause: "Selected instruction changed.",
              });
            const content = yield* texts.value.content({
              ...scope,
              kind: entry.kind,
              id: selected.resourceId,
              expectedRevision: selected.revision,
            });
            bodies.push(content.body);
          }
        }
        if (Option.isNone(composition)) {
          if (configuration.resources.skills.length > 0)
            return yield* new AssistantError({
              reason: "unavailable",
              cause: "Skill catalog unavailable.",
            });
          return {
            configurationHash: assistantConfigurationHash(record),
            resourceRevision: assistantMemoryContextHash(
              `${assistantConfigurationHash(record)}:${memory.text}`,
            ),
            memoryContextHash: assistantMemoryContextHash(memory.text),
            memoryEpoch: memory.memoryEpoch,
            roleInstructions: bodies.filter(Boolean).join("\n\n"),
            toolIds: configuration.resources.mcpTools.flatMap((value) =>
              value.toolNames.map((name) => `${value.definitionId}:${name}`),
            ),
            skillIds: [],
          };
        }
        const captured = yield* composition.value.compose({
          projectId: binding.backingProjectId,
          resourceRoot: record.workspaceRoot,
          threadId: binding.canonicalThreadId,
          providerInstanceId: configuration.modelSelection.instanceId,
          configuration: {
            skillIds: skillKeys,
            toolIds: configuration.resources.mcpTools.flatMap((value) =>
              value.toolNames.map((name) => `${value.definitionId}:${name}`),
            ),
            runtimeVersion: `assistant:${revision}`,
          },
          roleRevisionId: binding.assistantId,
          roleRevision: revision,
          roleInstructions: bodies.filter(Boolean).join("\n\n"),
        });
        return {
          ...captured.snapshot,
          resourceRevision: assistantMemoryContextHash(
            `${captured.snapshot.resourceRevision}:${memory.text}`,
          ),
          memoryContextHash: assistantMemoryContextHash(memory.text),
          memoryEpoch: memory.memoryEpoch,
          configurationHash: assistantConfigurationHash(record),
        };
      },
      Effect.mapError((cause) =>
        isAssistantError(cause) ? cause : new AssistantError({ reason: "unavailable", cause }),
      ),
    ),
  });
});
export const layer = Layer.effect(AssistantResources, make);
