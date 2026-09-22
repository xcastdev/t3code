import { assert, describe, it } from "@effect/vitest";
import type { ManagedSkillKey, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import {
  NativeSkillObservationService,
  layer,
  serverProviderSkillsToNativeCandidates,
  type NativeSkillCandidate,
} from "./NativeSkillObservationService.ts";

const instanceId = "codex-work" as ProviderInstanceId;
const key = "deploy" as ManagedSkillKey;

const candidate = (nativeIdentity: string, nativePath: string): NativeSkillCandidate => ({
  nativeIdentity,
  nativePath,
  key,
  displayName: "Deploy",
  source: "codex",
  scopeSummary: "project",
  providerEnabled: true,
  modelAvailable: true,
  userInvocable: true,
});

describe("NativeSkillObservationService", () => {
  class TestDiscoveryError extends Data.TaggedError("TestDiscoveryError") {}

  it("normalizes legacy provider skills without path identities", () => {
    const candidates = serverProviderSkillsToNativeCandidates("grok", [
      {
        name: "deploy",
        path: "/workspace/.grok/skills/deploy/SKILL.md",
        scope: "project",
        enabled: true,
        userInvocable: false,
      },
      {
        name: "deploy",
        path: "/home/test/.grok/skills/deploy/SKILL.md",
        scope: "user",
        enabled: false,
        userInvocationOnly: true,
      },
    ]);

    assert.equal(candidates.length, 2);
    assert.notEqual(candidates[0]?.nativeIdentity, candidates[1]?.nativeIdentity);
    assert.notInclude(candidates[0]!.nativeIdentity, "/workspace");
    assert.deepInclude(candidates[0], {
      key,
      source: "grok",
      scopeSummary: "project",
      providerEnabled: true,
      modelAvailable: true,
      userInvocable: false,
    });
    assert.deepInclude(candidates[1], {
      providerEnabled: false,
      modelAvailable: false,
      userInvocable: true,
    });
  });

  it.layer(Layer.merge(layer, TestClock.layer()))("discovery state", (it) => {
    it.effect("does not reuse another project's observations after discovery fails", () =>
      Effect.gen(function* () {
        const service = yield* NativeSkillObservationService;
        yield* service.discover({
          providerInstanceId: instanceId,
          scopeId: "/project-a",
          discovery: Effect.succeed([candidate("a", "/project-a/SKILL.md")]),
        });
        const result = yield* service.discover({
          providerInstanceId: instanceId,
          scopeId: "/project-b",
          discovery: Effect.fail(new TestDiscoveryError()),
        });
        assert.equal(result.freshness, "unavailable");
        assert.deepEqual(result.observations, []);
      }),
    );
    it.effect("keeps collisions distinct without exposing native paths", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000);
        const service = yield* NativeSkillObservationService;
        const result = yield* service.discover({
          providerInstanceId: instanceId,
          scopeId: "/workspace",
          discovery: Effect.succeed([
            candidate("project:deploy:a", "/workspace/.agents/skills/deploy/SKILL.md"),
            candidate("user:deploy:b", "/home/test/.codex/skills/deploy/SKILL.md"),
          ]),
        });

        assert.equal(result.freshness, "fresh");
        assert.equal(result.attemptedAt, "1970-01-01T00:00:01.000Z");
        assert.equal(result.observations.length, 2);
        assert.deepEqual(
          result.observations.map((observation) => observation.nativeIdentity),
          ["project:deploy:a", "user:deploy:b"],
        );
        assert.isFalse("nativePath" in result.observations[0]!);
        assert.notEqual(
          result.observations[0]?.observationId,
          result.observations[1]?.observationId,
        );

        const detail = yield* service.getObservation(result.observations[0]!.observationId);
        assert.equal(detail?.nativePath, "/workspace/.agents/skills/deploy/SKILL.md");
      }),
    );

    it.effect("retains the last successful observations as stale after failure", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(2_000);
        const service = yield* NativeSkillObservationService;
        const fresh = yield* service.discover({
          providerInstanceId: instanceId,
          scopeId: "/workspace",
          discovery: Effect.succeed([candidate("project:deploy", "/workspace/deploy/SKILL.md")]),
        });

        yield* TestClock.setTime(3_000);
        const stale = yield* service.discover({
          providerInstanceId: instanceId,
          scopeId: "/workspace",
          discovery: Effect.fail(new TestDiscoveryError()),
        });

        assert.equal(stale.freshness, "stale");
        assert.equal(stale.attemptedAt, "1970-01-01T00:00:03.000Z");
        assert.equal(stale.observations[0]?.observedAt, fresh.observations[0]?.observedAt);
        assert.deepInclude(stale.discoveryError, { code: "discovery_failed" });
        assert.deepInclude(stale.observations[0]?.discoveryError, {
          code: "discovery_failed",
        });
      }),
    );

    it.effect("treats a successful empty discovery as fresh and clears stale observations", () =>
      Effect.gen(function* () {
        const service = yield* NativeSkillObservationService;
        yield* service.discover({
          providerInstanceId: instanceId,
          scopeId: "/workspace",
          discovery: Effect.succeed([candidate("project:deploy", "/workspace/deploy/SKILL.md")]),
        });
        yield* service.discover({
          providerInstanceId: instanceId,
          scopeId: "/workspace",
          discovery: Effect.fail(new TestDiscoveryError()),
        });

        const empty = yield* service.discover({
          providerInstanceId: instanceId,
          scopeId: "/workspace",
          discovery: Effect.succeed([]),
        });
        assert.equal(empty.freshness, "fresh");
        assert.deepEqual(empty.observations, []);
        assert.isUndefined(empty.discoveryError);
      }),
    );

    it.effect("marks retained observations unavailable when a provider disconnects", () =>
      Effect.gen(function* () {
        const service = yield* NativeSkillObservationService;
        yield* service.discover({
          providerInstanceId: instanceId,
          scopeId: "/workspace",
          discovery: Effect.succeed([candidate("project:deploy", "/workspace/deploy/SKILL.md")]),
        });

        const unavailable = yield* service.markUnavailable(instanceId, "/workspace");
        assert.equal(unavailable.freshness, "unavailable");
        assert.equal(unavailable.observations[0]?.freshness, "unavailable");
        assert.deepInclude(unavailable.discoveryError, { code: "provider_unavailable" });
      }),
    );
  });
});
