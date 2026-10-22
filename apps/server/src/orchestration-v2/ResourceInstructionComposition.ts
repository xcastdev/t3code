// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  OrchestrationV2InstructionSnapshot,
  ProviderInstanceId,
  SkillCatalogRevision,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { freezeInstructionSnapshot } from "@t3tools/provider-core/server/instructionSnapshot";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { SkillCatalogService, type PreparedSkillResource } from "../skills/SkillCatalogService.ts";

export interface CompositionInput {
  readonly projectId: ProjectId;
  readonly resourceRoot: string;
  readonly threadId: ThreadId;
  readonly providerInstanceId: string;
  readonly configuration: {
    readonly skillIds: ReadonlyArray<string>;
    readonly toolIds: ReadonlyArray<string>;
    readonly runtimeVersion: string;
  };
  readonly roleRevisionId: string;
  readonly roleRevision: number;
  readonly roleInstructions: string;
}
export class ResourceCompositionError extends Schema.TaggedError<ResourceCompositionError>()(
  "ResourceCompositionError",
  { cause: Schema.Defect() },
) {}

const decodeSnapshot = Schema.decodeUnknownSync(OrchestrationV2InstructionSnapshot);
const isResourceCompositionError = Schema.is(ResourceCompositionError);
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");

/** Only verified managed packages are eligible; native discovery remains independent. */
export function composeInstructionSnapshot(
  input: CompositionInput,
  available: ReadonlyArray<PreparedSkillResource>,
): OrchestrationV2InstructionSnapshot {
  const selected = input.configuration.skillIds.map((id) => {
    const matches = available.filter((resource) => resource.id === id || resource.key === id);
    if (matches.length !== 1)
      throw new ResourceCompositionError({
        cause: `Selected managed skill ${id} is missing or ambiguous.`,
      });
    return matches[0]!;
  });
  if (new Set(selected.map((resource) => resource.id)).size !== selected.length)
    throw new ResourceCompositionError({ cause: "A managed skill was selected more than once." });
  const roleInstructions = [
    input.roleInstructions,
    ...selected.map(
      (resource) =>
        `Managed skill ${resource.key} (revision ${resource.revision}, sha256 ${resource.hash}):\n${resource.body}`,
    ),
  ].join("\n\n");
  const resourceRevision = hash({
    roleRevisionId: input.roleRevisionId,
    revision: input.roleRevision,
    resourceRoot: input.resourceRoot,
    tools: input.configuration.toolIds,
    selectedIds: input.configuration.skillIds,
    skills: selected.map(({ id, key, hash: contentHash, revision, body }) => ({
      id,
      key,
      hash: contentHash,
      revision,
      bodyHash: hash(body),
    })),
    runtimeVersion: input.configuration.runtimeVersion,
  });
  return freezeInstructionSnapshot(
    decodeSnapshot({
      configurationHash: hash({
        configuration: input.configuration,
        instructions: roleInstructions,
        resourceRevision,
      }),
      resourceRevision,
      memoryEpoch: 0,
      roleInstructions,
      toolIds: input.configuration.toolIds,
      skillIds: input.configuration.skillIds,
    }),
  );
}

export class ResourceInstructionComposition extends Context.Service<
  ResourceInstructionComposition,
  {
    readonly compose: (
      input: CompositionInput,
    ) => Effect.Effect<
      { readonly snapshot: OrchestrationV2InstructionSnapshot; readonly catalogRevision: number },
      ResourceCompositionError
    >;
  }
>()("t3/orchestration-v2/ResourceInstructionComposition") {}

export const layer = Layer.effect(
  ResourceInstructionComposition,
  Effect.gen(function* () {
    const catalog = yield* SkillCatalogService;
    return ResourceInstructionComposition.of({
      compose: Effect.fn("ResourceInstructionComposition.compose")(
        function* (input: CompositionInput) {
          const revision = yield* catalog.currentRevision;
          const prepared = yield* catalog.prepareSession({
            projectId: input.projectId,
            threadId: input.threadId,
            providerInstanceId: ProviderInstanceId.make(input.providerInstanceId),
            projectRoot: input.resourceRoot,
            cwd: input.resourceRoot,
            desiredRevision: revision,
            appliedRevision: SkillCatalogRevision.make(0),
          });
          if ((yield* catalog.currentRevision) !== revision)
            return yield* new ResourceCompositionError({
              cause: "Skill catalog changed during instruction preparation.",
            });
          const snapshot = yield* Effect.try({
            try: () => composeInstructionSnapshot(input, prepared.resources),
            catch: (cause) => new ResourceCompositionError({ cause }),
          });
          yield* catalog.recordPreparedResources({
            resourceRevision: snapshot.resourceRevision,
            catalogRevision: prepared.application.desiredRevision,
            resources: prepared.resources
              .filter((resource) =>
                input.configuration.skillIds.some(
                  (id) => id === resource.id || id === resource.key,
                ),
              )
              .map(({ id, key, hash, revision }) => ({ id, key, hash, revision })),
          });
          return { snapshot, catalogRevision: revision };
        },
        Effect.mapError((cause) =>
          isResourceCompositionError(cause) ? cause : new ResourceCompositionError({ cause }),
        ),
      ),
    });
  }),
);
