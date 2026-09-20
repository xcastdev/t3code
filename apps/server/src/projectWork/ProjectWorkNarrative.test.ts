import { ProjectId, ProjectWorkTaskId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { buildProjectWorkBriefing } from "./ProjectWorkBriefing.ts";
import * as ProjectWorkContentGuard from "./ProjectWorkContentGuard.ts";
import { makeProjectWorkNarrative } from "./ProjectWorkNarrative.ts";
import type { ProjectWorkSnapshot } from "./ProjectWorkQuery.ts";

const at = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("narrative-project");
const briefing = buildProjectWorkBriefing(
  {
    projectId,
    revision: 4,
    tasks: [
      {
        taskId: ProjectWorkTaskId.make("narrative-task"),
        projectId,
        title: "Narrative source",
        state: "ready",
        watchers: [],
        revision: 4,
        specRevision: 0,
        createdAt: at,
        updatedAt: at,
      },
    ],
    attempts: [],
    criteria: [],
    evidence: [],
    relationships: [],
    blockers: [],
    attention: [],
    activities: [],
    checkpoints: [],
    knowledge: [],
    decisions: [],
    comments: [],
  } satisfies ProjectWorkSnapshot,
  { projectId, kind: "standard", generatedAt: at },
);

describe("ProjectWorkNarrative", () => {
  it.effect("caches cited generation and invalidates older source revisions", () =>
    Effect.gen(function* () {
      let calls = 0;
      const service = makeProjectWorkNarrative({
        defaultModel: "test-model",
        now: () => at,
        generator: (input) =>
          Effect.sync(() => {
            calls += 1;
            return `Generated from ${input.citations.map((citation) => citation.recordId).join(",")}`;
          }),
      });
      const generated = yield* service.generate({ projectId, kind: "standard", briefing });
      expect(generated?.model).toBe("test-model");
      expect(generated?.sourceRevision).toBe(4);
      expect(generated?.citations.map((citation) => citation.recordId)).toEqual(["narrative-task"]);
      expect(calls).toBe(1);
      expect(yield* service.get({ projectId, kind: "standard", sourceRevision: 4 })).toEqual(
        generated,
      );
      yield* service.invalidateForRevision(String(projectId), 5);
      expect(
        yield* service.get({ projectId, kind: "standard", sourceRevision: 4 }),
      ).toBeUndefined();
      expect(yield* service.request({ projectId, kind: "standard", briefing })).toMatchObject({
        status: "scheduled",
      });
    }),
  );

  it.effect("does not reuse a same-revision briefing with different content", () =>
    Effect.gen(function* () {
      let calls = 0;
      const service = makeProjectWorkNarrative({
        now: () => at,
        generator: (input) =>
          Effect.sync(() => {
            calls += 1;
            return input.briefing.text;
          }),
      });
      const changed = { ...briefing, text: `${briefing.text}\nnew content` };
      yield* service.generate({ projectId, kind: "standard", briefing });
      const generated = yield* service.generate({ projectId, kind: "standard", briefing: changed });
      expect(generated?.narrative).toContain("new content");
      expect(calls).toBe(2);
    }),
  );

  it.effect("scrubs cached derived prose when a secret becomes known", () =>
    Effect.gen(function* () {
      const service = makeProjectWorkNarrative({
        now: () => at,
        generator: () => Effect.succeed("derived includes known-value-123456789"),
      });
      yield* service.generate({ projectId, kind: "standard", briefing });
      expect(yield* service.get({ projectId, kind: "standard" })).toBeDefined();
      expect(yield* service.scrub(["known-value-123456789"])).toBe(1);
      expect(yield* service.get({ projectId, kind: "standard" })).toBeUndefined();
    }),
  );

  it.effect("fences an in-flight narrative when a secret becomes known", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const service = makeProjectWorkNarrative({
        now: () => at,
        generator: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as("derived includes known-value-123456789"),
          ),
      });
      const running = yield* Effect.forkScoped(
        service.generate({ projectId, kind: "standard", briefing }),
      );
      yield* Deferred.await(started);
      expect(yield* service.scrub(["known-value-123456789"])).toBe(0);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);
      expect(yield* service.get({ projectId, kind: "standard" })).toBeUndefined();
    }),
  );

  it.effect("redacts generated prose before clipping and caching", () =>
    Effect.gen(function* () {
      const guard = yield* ProjectWorkContentGuard.ProjectWorkContentGuard;
      yield* guard.registerKnownSecrets(["known-secret-value"]);
      const service = makeProjectWorkNarrative({
        contentGuard: guard,
        generator: () => Effect.succeed(`known-secret-value ${"safe ".repeat(2_000)}`),
      });
      const generated = yield* service.generate({ projectId, kind: "standard", briefing });
      expect(generated?.narrative).toContain("[REDACTED_SECRET]");
      expect(generated?.narrative).not.toContain("known-secret-value");
      expect(generated?.narrative.length).toBeLessThanOrEqual(4_000);
      expect(yield* service.get({ projectId, kind: "standard" })).toEqual(generated);
    }).pipe(Effect.provide(ProjectWorkContentGuard.layer)),
  );

  it.effect("isolates provider and option variants while canonicalizing option order", () =>
    Effect.gen(function* () {
      let calls = 0;
      const selections = [] as Array<unknown>;
      const service = makeProjectWorkNarrative({
        now: () => at,
        generator: (input) =>
          Effect.sync(() => {
            calls += 1;
            selections.push(input.modelSelection);
            return `generated-${calls}`;
          }),
      });
      const codexSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "same-model",
        options: [
          { id: "reasoningEffort", value: "high" as const },
          { id: "fastMode", value: true as const },
        ],
      };
      const reorderedCodexSelection = {
        ...codexSelection,
        options: codexSelection.options.toReversed(),
      };
      const claudeSelection = {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "same-model",
        options: codexSelection.options,
      };

      const first = yield* service.generate({
        projectId,
        kind: "standard",
        briefing,
        modelSelection: codexSelection,
      });
      const reordered = yield* service.get({
        projectId,
        kind: "standard",
        modelSelection: reorderedCodexSelection,
        sourceRevision: briefing.sourceRevision,
      });
      const otherProvider = yield* service.generate({
        projectId,
        kind: "standard",
        briefing,
        modelSelection: claudeSelection,
      });
      expect(
        yield* service.get({
          projectId,
          kind: "standard",
          modelSelection: claudeSelection,
          sourceRevision: briefing.sourceRevision,
        }),
      ).toEqual(otherProvider);

      expect(first?.narrative).toBe("generated-1");
      expect(reordered).toEqual(first);
      expect(otherProvider?.narrative).toBe("generated-2");
      expect(calls).toBe(2);
      expect(selections).toEqual([codexSelection, claudeSelection]);
    }),
  );

  it.effect("keeps pending and invalidation fences independent of selection variants", () =>
    Effect.gen(function* () {
      const started = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      const releases = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      let calls = 0;
      const service = makeProjectWorkNarrative({
        now: () => at,
        generator: (input) => {
          const index = calls++;
          return Deferred.succeed(started[index]!, undefined).pipe(
            Effect.andThen(Deferred.await(releases[index]!)),
            Effect.as(`variant-${input.modelSelection?.instanceId}`),
          );
        },
      });
      const firstSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "same-model",
      };
      const secondSelection = {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "same-model",
      };

      expect(
        (yield* service.request({
          projectId,
          kind: "standard",
          briefing,
          modelSelection: firstSelection,
        })).status,
      ).toBe("scheduled");
      yield* Deferred.await(started[0]!);
      expect(
        (yield* service.request({
          projectId,
          kind: "standard",
          briefing,
          modelSelection: secondSelection,
        })).status,
      ).toBe("scheduled");
      yield* Deferred.await(started[1]!);

      yield* service.invalidateForRevision(String(projectId), briefing.sourceRevision + 1);
      yield* Deferred.succeed(releases[0]!, undefined);
      yield* Deferred.succeed(releases[1]!, undefined);
      yield* Effect.yieldNow;
      expect(
        yield* service.get({ projectId, kind: "standard", modelSelection: firstSelection }),
      ).toBeUndefined();
      expect(
        yield* service.get({ projectId, kind: "standard", modelSelection: secondSelection }),
      ).toBeUndefined();
    }),
  );

  it.effect("fences old deferred requests when replaced and when globally cleared", () =>
    Effect.gen(function* () {
      const started = [yield* Deferred.make<number>(), yield* Deferred.make<number>()];
      const releases = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      let calls = 0;
      const service = makeProjectWorkNarrative({
        now: () => at,
        generator: () => {
          const index = calls++;
          return Deferred.succeed(started[index]!, index).pipe(
            Effect.andThen(Deferred.await(releases[index]!)),
            Effect.as(`narrative-${index}`),
          );
        },
      });

      const first = yield* service.request({ projectId, kind: "standard", briefing });
      expect(first.status).toBe("scheduled");
      expect(yield* Deferred.await(started[0]!)).toBe(0);
      yield* service.invalidate(String(projectId));
      const replacement = yield* service.request({ projectId, kind: "standard", briefing });
      expect(replacement.status).toBe("scheduled");
      expect(yield* Deferred.await(started[1]!)).toBe(1);
      yield* Deferred.succeed(releases[0]!, undefined);
      yield* Effect.yieldNow;
      expect((yield* service.request({ projectId, kind: "standard", briefing })).status).toBe(
        "pending",
      );

      yield* Deferred.succeed(releases[1]!, undefined);
      yield* Effect.yieldNow;
      expect((yield* service.request({ projectId, kind: "standard", briefing })).status).toBe(
        "cached",
      );

      const directStarted = yield* Deferred.make<void>();
      const directRelease = yield* Deferred.make<void>();
      const directService = makeProjectWorkNarrative({
        now: () => at,
        generator: () =>
          Deferred.succeed(directStarted, undefined).pipe(
            Effect.andThen(Deferred.await(directRelease)),
            Effect.as("direct"),
          ),
      });
      const direct = yield* Effect.forkScoped(
        directService.generate({ projectId, kind: "standard", briefing }),
      );
      yield* Deferred.await(directStarted);
      yield* directService.clear;
      yield* Deferred.succeed(directRelease, undefined);
      yield* Effect.yieldNow;
      expect((yield* Fiber.join(direct))?.narrative).toBe("direct");
      expect(yield* directService.get({ projectId, kind: "standard" })).toBeUndefined();
    }),
  );
});
