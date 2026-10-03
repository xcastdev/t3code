import {
  ManagedSkillId,
  ManagedSkillKey,
  ProviderInstanceId,
  SkillCatalogRevision,
  SkillContentHash,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ProviderSkillPlan } from "../../skills/ProviderSkillAdapter.ts";
import {
  type SkillMaterializationServiceShape,
  withOwnedSkillMaterialization,
} from "../../skills/SkillMaterializationService.ts";
import { SKILL_BODY_FILE } from "../../skills/SkillPackage.ts";
import type { PiManagedLaunch } from "./PiManagedProcess.ts";
import { PiManagedRuntimeError } from "./PiManagedRuntime.ts";
import type { PiManagedSkillSelection } from "./PiManagedSkillSelection.ts";
import { type PreparedPiSkillResources, preparePiSkillResources } from "./PiSkillResources.ts";

const crypto = process.getBuiltinModule("crypto");
const path = process.getBuiltinModule("path").posix;
const emptyIdentity = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const absolute = Schema.String.check(
  Schema.isMaxLength(4096),
  Schema.isPattern(/^\/[^\0\r\n]*$/),
  Schema.makeFilter((value) => path.resolve(value) === value),
);
const keys = Schema.Array(ManagedSkillKey).check(
  Schema.isMaxLength(32),
  Schema.makeFilter((value) => new Set(value).size === value.length),
);
const planSchema = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  desiredRevision: SkillCatalogRevision,
  applicationMode: Schema.Literal("new_session_required"),
  skillKeys: keys,
  payload: Schema.Struct({
    kind: Schema.Literal("pi-managed-skills"),
    root: absolute,
    skills: Schema.Array(Schema.Struct({ key: ManagedSkillKey, path: absolute })).check(
      Schema.isMaxLength(32),
      Schema.makeFilter((value) => new Set(value.map((entry) => entry.key)).size === value.length),
    ),
  }),
});
const selectionSchema = Schema.Array(
  Schema.Struct({
    skillId: ManagedSkillId,
    key: ManagedSkillKey,
    packagePath: absolute,
    expectedHash: SkillContentHash.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
).check(
  Schema.isMaxLength(32),
  Schema.makeFilter(
    (value) =>
      new Set(value.map((entry) => entry.key)).size === value.length &&
      new Set(value.map((entry) => entry.skillId)).size === value.length,
  ),
);
const identitySchema = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
});
const boundedPath = Schema.String.check(Schema.isMaxLength(4096));
const stagingSchema = Schema.Struct({
  stagingRoot: boundedPath,
  stagingDirectory: boundedPath,
  existingRuntimeFiles: Schema.Array(
    Schema.Struct({ source: boundedPath, target: boundedPath }),
  ).check(Schema.isMaxLength(128)),
  protectedRoots: Schema.Array(boundedPath).check(Schema.isMaxLength(64)),
  writableRoots: Schema.Array(boundedPath).check(Schema.isMaxLength(64)),
});
const decodePlan = Schema.decodeUnknownSync(planSchema);
const decodeSelection = Schema.decodeUnknownSync(selectionSchema);
const decodeIdentity = Schema.decodeUnknownSync(identitySchema);
const decodeStaging = Schema.decodeUnknownSync(stagingSchema);
const encodeIdentities = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Tuple([ManagedSkillKey, SkillContentHash]))),
);
const rejected = (detail: string) => new PiManagedRuntimeError({ code: "denied", detail });

/** Resource identity uses only selected keys and complete package hashes, like PiSkillResources. */
export function piManagedSkillResourceIdentity(selection: ReadonlyArray<PiManagedSkillSelection>) {
  if (selection.length === 0) return emptyIdentity;
  return crypto
    .createHash("sha256")
    .update(
      encodeIdentities(
        [...selection]
          .sort((left, right) => left.key.localeCompare(right.key))
          .map((entry) => [entry.key, entry.expectedHash]),
      ),
    )
    .digest("hex");
}

export interface PiManagedSkillResourcesInput {
  readonly selection: ReadonlyArray<PiManagedSkillSelection>;
  readonly skillPlan: ProviderSkillPlan | undefined;
  readonly materialization: SkillMaterializationServiceShape;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly stagingRoot: string;
  readonly stagingDirectory: string;
  readonly existingRuntimeFiles: PiManagedLaunch["runtimeFiles"];
  readonly protectedRoots: ReadonlyArray<string>;
  readonly writableRoots: ReadonlyArray<string>;
  readonly authorizeCurrent: Effect.Effect<void, PiManagedRuntimeError>;
}

const prepareCaptured = Effect.fn("PiManagedSkillResources.prepareCaptured")(function* (
  input: PiManagedSkillResourcesInput,
  plan: typeof planSchema.Type | undefined,
): Effect.fn.Return<
  PreparedPiSkillResources,
  PiManagedRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  const options = {
    stagingRoot: input.stagingRoot,
    stagingDirectory: input.stagingDirectory,
    existingRuntimeFiles: input.existingRuntimeFiles,
    protectedRoots: input.protectedRoots,
    writableRoots: input.writableRoots,
  };
  if (plan === undefined) {
    if (input.selection.length !== 0)
      return yield* rejected("Selected managed skills require an explicit materialization plan.");
    return yield* preparePiSkillResources({ ...options, selection: [] });
  }
  const selectedKeys = input.selection.map((entry) => entry.key).sort();
  const planKeys = [...plan.skillKeys].sort();
  const payloadKeys = plan.payload.skills.map((entry) => entry.key).sort();
  if (
    plan.providerInstanceId !== input.providerInstanceId ||
    selectedKeys.length !== planKeys.length ||
    selectedKeys.length !== payloadKeys.length ||
    selectedKeys.some((key, index) => key !== planKeys[index] || key !== payloadKeys[index])
  )
    return yield* rejected("Managed skill plan instance or exact selected key set does not match.");

  yield* input.authorizeCurrent;
  const resources = yield* withOwnedSkillMaterialization(
    input.materialization,
    {
      sessionId: `thread-${crypto.createHash("sha256").update(input.threadId).digest("hex").slice(0, 24)}`,
      providerInstanceId: input.providerInstanceId,
      desiredRevision: plan.desiredRevision,
      skillKeys: selectedKeys,
    },
    (owned) =>
      Effect.gen(function* () {
        yield* input.authorizeCurrent;
        if (
          plan.payload.root !== owned.root ||
          plan.payload.skills.some(
            (entry) => entry.path !== path.join(owned.skillPaths.get(entry.key)!, SKILL_BODY_FILE),
          )
        )
          return yield* rejected(
            "Managed skill plan paths do not match the owned materialization.",
          );
        yield* owned.revalidate;
        const prepared = yield* preparePiSkillResources({
          ...options,
          selection: input.selection.map((entry) => ({
            key: entry.key,
            packagePath: owned.skillPaths.get(entry.key)!,
            expectedHash: entry.expectedHash,
          })),
        });
        yield* owned.revalidate;
        yield* input.authorizeCurrent;
        return prepared;
      }),
  ).pipe(
    Effect.mapError((error) =>
      error._tag === "PiManagedRuntimeError"
        ? error
        : rejected("Owned managed skill materialization is unavailable or changed."),
    ),
  );
  yield* input.authorizeCurrent;
  // Owned revalidation closes with its callback. Only the resource helper's independent
  // receipts and current authority may survive this preparation.
  const revalidate = Effect.gen(function* () {
    yield* input.authorizeCurrent;
    yield* resources.revalidate;
    yield* input.authorizeCurrent;
  });
  return { ...resources, revalidate };
});

/** Root supplies current authority and cache policy; plan paths never authorize source access. */
export function preparePiManagedSkillResources(
  input: PiManagedSkillResourcesInput,
): Effect.Effect<
  PreparedPiSkillResources,
  PiManagedRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  // Capture before any asynchronous admission or authorization, including before Effect execution.
  try {
    const selection = Object.freeze(
      decodeSelection(input.selection, { onExcessProperty: "error" }).map((entry) =>
        Object.freeze({ ...entry }),
      ),
    );
    const identity = decodeIdentity(
      { threadId: input.threadId, providerInstanceId: input.providerInstanceId },
      { onExcessProperty: "error" },
    );
    const decoded =
      input.skillPlan === undefined
        ? undefined
        : decodePlan(input.skillPlan, { onExcessProperty: "error" });
    const plan =
      decoded === undefined
        ? undefined
        : Object.freeze({
            ...decoded,
            skillKeys: Object.freeze([...decoded.skillKeys]),
            payload: Object.freeze({
              ...decoded.payload,
              skills: Object.freeze(
                decoded.payload.skills.map((entry) => Object.freeze({ ...entry })),
              ),
            }),
          });
    const staging = decodeStaging(
      {
        stagingRoot: input.stagingRoot,
        stagingDirectory: input.stagingDirectory,
        existingRuntimeFiles: input.existingRuntimeFiles,
        protectedRoots: input.protectedRoots,
        writableRoots: input.writableRoots,
      },
      { onExcessProperty: "error" },
    );
    const captured = Object.freeze({
      ...identity,
      selection,
      skillPlan: plan,
      materialization: input.materialization,
      stagingRoot: staging.stagingRoot,
      stagingDirectory: staging.stagingDirectory,
      existingRuntimeFiles: Object.freeze(
        staging.existingRuntimeFiles.map((entry) => Object.freeze({ ...entry })),
      ),
      protectedRoots: Object.freeze([...staging.protectedRoots]),
      writableRoots: Object.freeze([...staging.writableRoots]),
      authorizeCurrent: input.authorizeCurrent,
    });
    return prepareCaptured(captured, plan);
  } catch {
    return Effect.fail(rejected("Managed skill plan, selection or runtime identity is invalid."));
  }
}
