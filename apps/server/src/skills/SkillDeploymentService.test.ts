import { describe, expect, it } from "@effect/vitest";
import { ManagedSkillKey, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { NodeServices } from "@effect/platform-node";

import { makeSkillDeploymentService } from "./SkillDeploymentService.ts";
import { hashSkillPackage } from "./SkillPackage.ts";

const encodeFixtureManifest = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const makeOwnedFixture = Effect.fn("SkillDeploymentService.test.makeOwnedFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skill-deployment-rollback-" });
  const source = path.join(root, "source", "review");
  const targetRoot = path.join(root, "provider-skills");
  yield* fs.makeDirectory(source, { recursive: true });
  const writeSource = Effect.fn("SkillDeploymentService.test.writeSource")(function* (
    revision: number,
  ) {
    const manifest = {
      schemaVersion: 1,
      kind: "managed-skill",
      id: "id-review",
      key: "review",
      scope: "global",
      origin: "created",
      ownership: "t3",
      revision: { revision, hash: "pending" },
    };
    yield* fs.writeFileString(path.join(source, "t3-skill.json"), encodeFixtureManifest(manifest));
    yield* fs.writeFileString(
      path.join(source, "SKILL.md"),
      `---\nname: review\ndescription: Review changes\n---\nRevision ${revision}.`,
    );
    const hash = yield* hashSkillPackage(source);
    yield* fs.writeFileString(
      path.join(source, "t3-skill.json"),
      encodeFixtureManifest({ ...manifest, revision: { revision, hash } }),
    );
  });
  yield* writeSource(1);
  const service = yield* makeSkillDeploymentService;
  const input = {
    providerInstanceId: ProviderInstanceId.make("codex"),
    targetRoot,
    key: ManagedSkillKey.make("review"),
    sourcePath: source,
  };
  yield* service.install(input);
  const target = path.join(targetRoot, input.key);
  const marker = path.join(targetRoot, ".t3-managed-review.json");
  const originalHash = yield* hashSkillPackage(target);
  const originalMarker = yield* fs.readFileString(marker);
  yield* writeSource(2);
  return { fs, path, service, input, target, marker, originalHash, originalMarker };
});

describe("SkillDeploymentService", () => {
  it.effect("finds and removes an owned install after its managed source is deleted", () =>
    Effect.gen(function* () {
      const { fs, path, service, input, target } = yield* makeOwnedFixture();
      yield* fs.remove(path.dirname(input.sourcePath), { recursive: true });
      const installed = yield* service.listOwned({
        providerInstanceId: input.providerInstanceId,
        targetRoot: input.targetRoot,
      });
      expect(installed).toMatchObject([{ key: input.key, state: "owned" }]);
      yield* service.uninstall({ ...input, sourcePath: "" });
      expect(yield* fs.exists(target)).toBe(false);
      expect(
        yield* service.listOwned({
          providerInstanceId: input.providerInstanceId,
          targetRoot: input.targetRoot,
        }),
      ).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  for (const stage of [
    "copy",
    "staged-validation",
    "marker-stage",
    "target-backup",
    "marker-backup",
    "target-publish",
    "marker-publish",
  ] as const) {
    it.effect(`preserves the owned package and marker after ${stage} failure`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeOwnedFixture();
        const { fs, path, input, target, marker, service } = fixture;
        let injected = 0;
        const failure = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: stage,
        });
        const faulted = yield* makeSkillDeploymentService.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            copy: (from, to, ...args) =>
              fs.copy(from, to, ...args).pipe(
                Effect.flatMap(() => {
                  if (stage === "copy") {
                    injected += 1;
                    return Effect.fail(failure);
                  }
                  if (stage === "staged-validation") {
                    injected += 1;
                    return fs.writeFileString(path.join(to, "SKILL.md"), "changed during copy");
                  }
                  return Effect.void;
                }),
              ),
            writeFileString: (file, content, ...args) => {
              if (stage === "marker-stage" && file.startsWith(`${marker}.pending-`)) {
                injected += 1;
                return Effect.fail(failure);
              }
              return fs.writeFileString(file, content, ...args);
            },
            rename: (from, to) => {
              const matches =
                stage === "target-backup"
                  ? from === target
                  : stage === "marker-backup"
                    ? from === marker
                    : stage === "target-publish"
                      ? from.startsWith(`${target}.pending-`)
                      : stage === "marker-publish"
                        ? from.startsWith(`${marker}.pending-`)
                        : false;
              if (matches) {
                injected += 1;
                return Effect.fail(failure);
              }
              return fs.rename(from, to);
            },
          }),
        );
        const error = yield* faulted.install(input).pipe(Effect.flip);
        expect(error.code).toBe(
          stage === "staged-validation" ? "invalid_source" : "deployment_failed",
        );
        expect(injected).toBe(1);
        expect(yield* hashSkillPackage(target)).toBe(fixture.originalHash);
        expect(yield* fs.readFileString(marker)).toBe(fixture.originalMarker);
        expect((yield* service.status(input)).state).toBe("owned");
        expect((yield* fs.readDirectory(input.targetRoot)).sort()).toEqual([
          ".t3-managed-review.json",
          "review",
        ]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("restores the target when uninstall cannot rename its ownership marker", () =>
    Effect.gen(function* () {
      const fixture = yield* makeOwnedFixture();
      const { fs, input, target, marker, service } = fixture;
      let injected = 0;
      const faulted = yield* makeSkillDeploymentService.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) => {
            if (from === marker) {
              injected += 1;
              return Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                }),
              );
            }
            return fs.rename(from, to);
          },
        }),
      );
      const error = yield* faulted.uninstall(input).pipe(Effect.flip);
      expect(error.code).toBe("deployment_failed");
      expect(injected).toBe(1);
      expect(yield* hashSkillPackage(target)).toBe(fixture.originalHash);
      expect(yield* fs.readFileString(marker)).toBe(fixture.originalMarker);
      expect((yield* service.status(input)).state).toBe("owned");
      expect((yield* fs.readDirectory(input.targetRoot)).sort()).toEqual([
        ".t3-managed-review.json",
        "review",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses collisions and protects drifted owned deployments", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "skill-deployment-" });
      const source = path.join(root, "source", "review");
      const targetRoot = path.join(root, "provider-skills");
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.writeFileString(
        path.join(source, "t3-skill.json"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          schemaVersion: 1,
          kind: "managed-skill",
          id: "id-review",
          key: "review",
          scope: "global",
          origin: "created",
          ownership: "t3",
          revision: { revision: 1, hash: "pending" },
        }),
      );
      yield* fs.writeFileString(
        path.join(source, "SKILL.md"),
        "---\nname: review\ndescription: Review changes\n---\nReview.",
      );
      const sourceHash = yield* hashSkillPackage(source);
      yield* fs.writeFileString(
        path.join(source, "t3-skill.json"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          schemaVersion: 1,
          kind: "managed-skill",
          id: "id-review",
          key: "review",
          scope: "global",
          origin: "created",
          ownership: "t3",
          revision: { revision: 1, hash: sourceHash },
        }),
      );
      const service = yield* makeSkillDeploymentService;
      const input = {
        providerInstanceId: ProviderInstanceId.make("codex"),
        targetRoot,
        key: ManagedSkillKey.make("review"),
        sourcePath: source,
      };
      expect((yield* service.install(input)).state).toBe("owned");
      expect((yield* service.status(input)).state).toBe("owned");
      yield* fs.writeFileString(path.join(targetRoot, "review", "SKILL.md"), "changed");
      expect((yield* service.status(input)).state).toBe("drifted");
      const updateFailure = yield* service.install(input).pipe(Effect.flip);
      expect(updateFailure.code).toBe("installed_drift");
      const uninstallFailure = yield* service.uninstall(input).pipe(Effect.flip);
      expect(uninstallFailure.code).toBe("installed_drift");

      const collisionRoot = path.join(root, "collision");
      yield* fs.makeDirectory(path.join(collisionRoot, "review"), { recursive: true });
      const collision = yield* service
        .install({ ...input, targetRoot: collisionRoot })
        .pipe(Effect.flip);
      expect(collision.code).toBe("destination_collision");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
