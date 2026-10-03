import {
  ManagedSkillContent,
  ManagedSkillId,
  ManagedSkillKey,
  ManagedSkillManifest,
  SkillContentHash,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ManagedSkillRepository,
  type SkillPackageEntry,
} from "../../skills/ManagedSkillRepository.ts";
import { toSkillCatalogEntry } from "../../skills/SkillCatalogIndex.ts";
import { resolveSkillCatalog } from "../../skills/SkillCatalogResolver.ts";

export class PiManagedSkillSelectionError extends Schema.TaggedError<PiManagedSkillSelectionError>()(
  "PiManagedSkillSelectionError",
  { code: Schema.Literals(["denied", "unavailable"]), detail: Schema.String },
) {}

const denied = (detail: string) => new PiManagedSkillSelectionError({ code: "denied", detail });
const selectedIds = Schema.Array(ManagedSkillId).check(Schema.isMaxLength(32));
const roleIds = Schema.Array(ManagedSkillId).check(Schema.isMaxLength(64));
const absolute = Schema.String.check(Schema.isMaxLength(4096), Schema.isPattern(/^\/[^\0\r\n]*$/));
const packageSchema = Schema.Struct({
  packagePath: absolute,
  manifest: ManagedSkillManifest,
  content: ManagedSkillContent,
  projectState: Schema.optionalKey(Schema.Literal("override")),
});
const decodePackage = Schema.decodeUnknownEffect(packageSchema);
const encodePackage = Schema.encodeEffect(Schema.fromJsonString(packageSchema));
const selectionSchema = Schema.Struct({
  skillId: ManagedSkillId,
  key: ManagedSkillKey,
  packagePath: absolute,
  expectedHash: SkillContentHash,
});
export type PiManagedSkillSelection = typeof selectionSchema.Type;

// Repository scans bound each inspected package, but not the number of packages.
// Keep both scopes: a project tombstone or invalid override must block inheritance.
const readCatalog = Effect.fn("PiManagedSkillSelection.readCatalog")(function* (
  projectRoot: string,
) {
  const repository = yield* ManagedSkillRepository;
  const global = yield* repository.listGlobal().pipe(
    Effect.mapError(
      () =>
        new PiManagedSkillSelectionError({
          code: "unavailable",
          detail: "Managed skill catalogue cannot be read.",
        }),
    ),
  );
  const project = yield* repository.listProject(projectRoot).pipe(
    Effect.mapError(
      () =>
        new PiManagedSkillSelectionError({
          code: "unavailable",
          detail: "Managed skill catalogue cannot be read.",
        }),
    ),
  );
  return { global, project };
});

const selectWinners = Effect.fn("PiManagedSkillSelection.selectWinners")(function* (
  catalog: {
    readonly global: ReadonlyArray<SkillPackageEntry>;
    readonly project: ReadonlyArray<SkillPackageEntry>;
  },
  ids: ReadonlyArray<ManagedSkillId>,
) {
  const resolved = resolveSkillCatalog({
    global: {
      scope: "global",
      scopeId: "global",
      catalogRevision: 0,
      availability: "available",
      entries: catalog.global.map((entry) => toSkillCatalogEntry(entry, "global")),
    },
    project: {
      scope: "project",
      scopeId: "project",
      catalogRevision: 0,
      availability: "available",
      entries: catalog.project.map((entry) => toSkillCatalogEntry(entry, "project")),
    },
  });
  const allEntries = [...catalog.global, ...catalog.project];
  const winners = [];
  for (const id of ids) {
    if (allEntries.filter((entry) => entry.manifest?.id === id).length !== 1) {
      return yield* denied("Selected managed skill ID is missing or ambiguous.");
    }
    const matches = [...resolved.byKey.values()].filter((item) => item.winner?.skillId === id);
    const item = matches[0];
    const winner = item?.winner;
    if (
      matches.length !== 1 ||
      item?.validity !== "valid" ||
      !item.effective ||
      winner === undefined
    ) {
      return yield* denied("Selected managed skill is not a current effective winner.");
    }
    const entry = catalog[winner.scope][winner.candidateIndex];
    if (
      entry === undefined ||
      entry.hash !== winner.hash ||
      entry.manifest?.ownership !== "t3" ||
      entry.manifest.scope !== winner.scope ||
      entry.directoryName !== winner.key
    ) {
      return yield* denied("Selected managed skill ownership or inspected identity is invalid.");
    }
    const owned = yield* decodePackage(entry).pipe(
      Effect.mapError(() => denied("Selected managed skill package is invalid.")),
    );
    const selection = yield* Schema.decodeUnknownEffect(selectionSchema)({
      skillId: id,
      key: winner.key,
      packagePath: owned.packagePath,
      expectedHash: entry.hash,
    }).pipe(Effect.mapError(() => denied("Selected managed skill identity is invalid.")));
    const fingerprint = yield* encodePackage(owned).pipe(
      Effect.mapError(() => denied("Selected managed skill package cannot be validated.")),
    );
    winners.push({ selection, scope: winner.scope, fingerprint });
  }
  return winners.sort((left, right) => left.selection.key.localeCompare(right.selection.key));
});

/** The caller must obtain current durable authority and verify the canonical primary project root.
 * This resolves resources only; PiSkillResources owns physical staging and final admission.
 */
export const resolvePiManagedSkillSelection = Effect.fn("resolvePiManagedSkillSelection")(
  function* (input: {
    readonly projectRoot: string;
    readonly selectedSkillIds: ReadonlyArray<string>;
    readonly roleSkillIds: ReadonlyArray<string>;
  }): Effect.fn.Return<
    ReadonlyArray<PiManagedSkillSelection>,
    PiManagedSkillSelectionError,
    ManagedSkillRepository
  > {
    const ids = yield* Schema.decodeEffect(selectedIds)(input.selectedSkillIds).pipe(
      Effect.mapError(() => denied("Selected managed skill IDs are invalid or exceed the limit.")),
    );
    if (ids.length === 0) return Object.freeze([]);
    const roles = yield* Schema.decodeEffect(roleIds)(input.roleSkillIds).pipe(
      Effect.mapError(() => denied("Frozen role managed skill IDs are invalid.")),
    );
    if (new Set(ids).size !== ids.length || ids.some((id) => !roles.includes(id))) {
      return yield* denied(
        "Selected managed skill IDs must be unique and allowed by the frozen role.",
      );
    }
    const projectRoot = yield* Schema.decodeEffect(absolute)(input.projectRoot).pipe(
      Effect.mapError(() => denied("Managed skill project root is invalid.")),
    );
    const repository = yield* ManagedSkillRepository;
    const before = yield* selectWinners(yield* readCatalog(projectRoot), ids);
    for (const winner of before) {
      // Native repository reads inspect the complete package hash and owned-root guards.
      const value = yield* (
        winner.scope === "global"
          ? repository.readGlobal(winner.selection.skillId)
          : repository.readProject(projectRoot, winner.selection.skillId)
      ).pipe(Effect.mapError(() => denied("Selected managed skill package cannot be read.")));
      const owned = yield* decodePackage(value).pipe(
        Effect.mapError(() => denied("Repository returned an invalid selected package.")),
      );
      const fingerprint = yield* encodePackage(owned).pipe(
        Effect.mapError(() => denied("Repository returned an invalid selected package.")),
      );
      if (fingerprint !== winner.fingerprint)
        return yield* denied("Selected managed skill changed during its owned read.");
    }
    const after = yield* selectWinners(yield* readCatalog(projectRoot), ids);
    if (
      before.some(
        (winner, index) =>
          winner.scope !== after[index]?.scope || winner.fingerprint !== after[index]?.fingerprint,
      )
    ) {
      return yield* denied("Selected managed skill winners changed during resolution.");
    }
    return Object.freeze(before.map((winner) => Object.freeze(winner.selection)));
  },
);
