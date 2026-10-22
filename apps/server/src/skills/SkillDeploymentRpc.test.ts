import { describe, expect, it } from "@effect/vitest";
import {
  ManagedSkillId,
  ManagedSkillKey,
  ProviderInstanceId,
  SkillContentHash,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { NodeServices } from "@effect/platform-node";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { SkillCatalogService } from "./SkillCatalogService.ts";
import { SkillDeploymentService, makeSkillDeploymentService } from "./SkillDeploymentService.ts";
import { hashSkillPackage } from "./SkillPackage.ts";

import { selectSkillDeploymentChange, makeSkillDeploymentRpc } from "./SkillDeploymentRpc.ts";
import { skillInstallTargets } from "./SkillInstallTargets.ts";
import { ProviderDriverKind } from "@t3tools/contracts";

const skillId = ManagedSkillId.make("skill-review");
const providerInstanceId = ProviderInstanceId.make("codex");
const key = ManagedSkillKey.make("review");
const hash = SkillContentHash.make("hash-1");
const targets = skillInstallTargets({
  driverKind: ProviderDriverKind.make("codex"),
  environment: { HOME: "/tmp/person" },
  projectRoot: "/tmp/project",
});
const source = { key, hash, packagePath: "/tmp/source/review" };

describe("skill deployment RPC selection", () => {
  it.effect("selects the authoritative target and rejects a stale source revision", () =>
    Effect.gen(function* () {
      const input = {
        skillId,
        providerInstanceId,
        target: "agents-project" as const,
        operation: "install" as const,
        expectedHash: hash,
      };
      expect((yield* selectSkillDeploymentChange(input, source, targets)).target.root).toBe(
        "/tmp/project/.agents/skills",
      );
      const stale = yield* selectSkillDeploymentChange(
        { ...input, expectedHash: SkillContentHash.make("stale") },
        source,
        targets,
      ).pipe(Effect.flip);
      expect(stale.code).toBe("revision_conflict");
      const wrongTarget = yield* selectSkillDeploymentChange(
        { ...input, target: "provider-project" },
        source,
        targets,
      ).pipe(Effect.flip);
      expect(wrongTarget.code).toBe("install_unavailable");
    }),
  );

  it.effect("allows uninstall of a T3-owned copy after the source is gone", () =>
    Effect.gen(function* () {
      const selected = yield* selectSkillDeploymentChange(
        { providerInstanceId, target: "agents-user", operation: "uninstall", key },
        undefined,
        targets,
      );
      expect(selected).toMatchObject({
        key,
        sourcePath: "",
        target: { root: "/tmp/person/.agents/skills" },
      });
      const missing = yield* selectSkillDeploymentChange(
        { providerInstanceId, target: "agents-user", operation: "uninstall" },
        undefined,
        targets,
      ).pipe(Effect.flip);
      expect(missing.code).toBe("invalid_request");
    }),
  );
});

const makeRpcFixture = Effect.fn("SkillDeploymentRpc.test.makeFixture")(function* (
  sharedRoot = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skill-deployment-rpc-" });
  const packagePath = path.join(root, "source");
  yield* fs.makeDirectory(packagePath);
  yield* fs.writeFileString(
    path.join(packagePath, "SKILL.md"),
    "---\nname: review\ndescription: Review changes\n---\nReview.",
  );
  const currentHash = yield* hashSkillPackage(packagePath);
  const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
  yield* fs.writeFileString(
    path.join(packagePath, "t3-skill.json"),
    yield* encode({
      schemaVersion: 1,
      kind: "managed-skill",
      id: skillId,
      key,
      scope: "global",
      origin: "created",
      ownership: "t3",
      revision: { revision: 1, hash: currentHash },
    }),
  );
  const firstId = ProviderInstanceId.make("codex-first");
  const secondId = ProviderInstanceId.make("codex-second");
  const unsupportedId = ProviderInstanceId.make("codex-no-install-hook");
  const firstRoot = path.join(root, "configured-first");
  const secondRoot = sharedRoot ? firstRoot : path.join(root, "configured-second");
  const configured = (instanceId: ProviderInstanceId, targetRoot?: string): ProviderInstance => ({
    instanceId,
    driverKind: ProviderDriverKind.make("codex"),
    enabled: true,
    displayName: undefined,
    continuationIdentity: {
      driverKind: ProviderDriverKind.make("codex"),
      continuationKey: instanceId,
    },
    ...(targetRoot === undefined
      ? {}
      : {
          resolveSkillInstallTargets: () =>
            Effect.succeed([
              {
                id: "agents-project" as const,
                root: targetRoot,
                readers: [ProviderDriverKind.make("codex")],
              },
            ]),
        }),
    get orchestrationAdapter(): never {
      throw new Error("Skill deployment must not start provider sessions.");
    },
    get snapshot(): never {
      throw new Error("Skill deployment must not probe providers.");
    },
    get textGeneration(): never {
      throw new Error("Skill deployment must not generate text.");
    },
  });
  const instances = [
    configured(firstId, firstRoot),
    configured(secondId, secondRoot),
    configured(unsupportedId),
  ];
  const deployment = yield* makeSkillDeploymentService;
  const rpc = yield* makeSkillDeploymentRpc.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry)({
          getInstance: (id) =>
            Effect.succeed(instances.find((instance) => instance.instanceId === id)),
        }),
        Layer.mock(SkillCatalogService)({
          source: () => Effect.succeed({ key, hash: currentHash, packagePath }),
          notifyInstalledSkillChanged: () => Effect.void,
        }),
        Layer.succeed(SkillDeploymentService, deployment),
      ),
    ),
  );
  return {
    fs,
    path,
    root,
    packagePath,
    currentHash,
    firstId,
    secondId,
    unsupportedId,
    firstRoot,
    secondRoot,
    rpc,
  };
});

it.effect(
  "deployment coordinator uses configured instances and rejects stale selections before native writes",
  () =>
    Effect.gen(function* () {
      const {
        fs,
        path,
        rpc,
        currentHash,
        firstId,
        secondId,
        unsupportedId,
        firstRoot,
        secondRoot,
      } = yield* makeRpcFixture();
      const input = {
        skillId,
        target: "agents-project" as const,
        operation: "install" as const,
        expectedHash: currentHash,
      };
      expect((yield* rpc.change({ ...input, providerInstanceId: firstId })).status.status).toBe(
        "owned",
      );
      expect(
        (yield* rpc
          .change({ ...input, providerInstanceId: secondId, expectedHash: hash })
          .pipe(Effect.flip)).code,
      ).toBe("revision_conflict");
      expect(yield* fs.exists(secondRoot)).toBe(false);
      expect(
        (yield* rpc.change({ ...input, providerInstanceId: unsupportedId }).pipe(Effect.flip)).code,
      ).toBe("install_unavailable");
      expect((yield* rpc.change({ ...input, providerInstanceId: secondId })).status.path).toBe(
        secondRoot,
      );
      expect(yield* fs.readFileString(path.join(firstRoot, ".t3-managed-review.json"))).toContain(
        firstId,
      );
      expect(yield* fs.readFileString(path.join(secondRoot, ".t3-managed-review.json"))).toContain(
        secondId,
      );
      yield* fs.writeFileString(
        path.join(firstRoot, "review", "SKILL.md"),
        "User edited installed copy",
      );
      expect((yield* rpc.list({ skillId, providerInstanceId: firstId })).targets[0]?.status).toBe(
        "drifted",
      );
      expect(
        (yield* rpc
          .change({
            providerInstanceId: firstId,
            key,
            target: "agents-project",
            operation: "uninstall",
          })
          .pipe(Effect.flip)).code,
      ).toBe("installed_drift");
      expect(yield* fs.readFileString(path.join(firstRoot, "review", "SKILL.md"))).toBe(
        "User edited installed copy",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "deployment coordinator preserves cross-instance ownership and uninstalls after source deletion",
  () =>
    Effect.gen(function* () {
      const { fs, path, rpc, currentHash, firstId, secondId, firstRoot, packagePath } =
        yield* makeRpcFixture(true);
      const input = {
        skillId,
        target: "agents-project" as const,
        operation: "install" as const,
        expectedHash: currentHash,
      };
      yield* rpc.change({ ...input, providerInstanceId: firstId });
      expect(
        (yield* rpc.change({ ...input, providerInstanceId: secondId }).pipe(Effect.flip)).code,
      ).toBe("ownership_mismatch");
      yield* fs.remove(packagePath, { recursive: true });
      expect((yield* rpc.list({ providerInstanceId: firstId })).targets).toMatchObject([
        { key, status: "owned" },
      ]);
      expect(
        (yield* rpc.change({
          providerInstanceId: firstId,
          key,
          target: "agents-project",
          operation: "uninstall",
        })).status.status,
      ).toBe("absent");
      expect(yield* fs.exists(path.join(firstRoot, "review"))).toBe(false);
      expect(yield* fs.exists(path.join(firstRoot, ".t3-managed-review.json"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
