import { describe, expect, it } from "@effect/vitest";
import {
  ManagedSkillId,
  ManagedSkillKey,
  ProviderInstanceId,
  SkillContentHash,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { selectSkillDeploymentChange } from "./SkillDeploymentRpc.ts";
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
