import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  assertProjectWorkContentSafe,
  ProjectWorkContentRejectedError,
  redactProjectWorkContent,
  findProjectWorkSecrets,
} from "./ProjectWorkContentGuard.ts";
import * as ProjectWorkContentGuard from "./ProjectWorkContentGuard.ts";
import * as ProjectWorkNarrative from "./ProjectWorkNarrative.ts";
import { makeProjectWorkNarrative } from "./ProjectWorkNarrative.ts";

describe("ProjectWorkContentGuard", () => {
  it("rejects high-confidence provider credentials while allowing ordinary prose", () => {
    expect(() =>
      assertProjectWorkContentSafe({ body: "Use the provider token below." }),
    ).not.toThrow();
    expect(() =>
      assertProjectWorkContentSafe({
        body: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
      }),
    ).toThrow(ProjectWorkContentRejectedError);
    expect(findProjectWorkSecrets("github_pat_abcdefghijklmnopqrstuvwxyz123456")).toHaveLength(1);
  });

  it("redacts known and newly detected secrets recursively", () => {
    const result = redactProjectWorkContent(
      {
        title: "A task",
        nested: ["known-value-123456789", "token=abcdefghijklmnopqrstuvwxyz123456"],
      },
      ["known-value-123456789"],
    );
    expect(result.value).toEqual({
      title: "A task",
      nested: ["[REDACTED_SECRET]", "token=[REDACTED_SECRET]"],
    });
    expect(result.redactions).toEqual(["$.nested[0]", "$.nested[1]"]);
  });

  effectIt.effect("scrubs the derived narrative cache when a secret becomes known", () => {
    const narrative = makeProjectWorkNarrative();
    const layer = ProjectWorkContentGuard.layer.pipe(
      Layer.provide(Layer.succeed(ProjectWorkNarrative.ProjectWorkNarrative, narrative)),
    );
    return Effect.gen(function* () {
      const guard = yield* ProjectWorkContentGuard.ProjectWorkContentGuard;
      expect(yield* guard.registerKnownSecrets(["new-secret-value"])).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  effectIt.effect("rejects content containing a registered secret", () => {
    const layer = ProjectWorkContentGuard.layer;
    return Effect.gen(function* () {
      const guard = yield* ProjectWorkContentGuard.ProjectWorkContentGuard;
      yield* guard.registerKnownSecrets(["known-secret-value"]);
      const result = yield* guard.assertSafe({ body: "known-secret-value" }).pipe(
        Effect.match({
          onFailure: () => "rejected" as const,
          onSuccess: () => "accepted" as const,
        }),
      );
      expect(result).toBe("rejected");
    }).pipe(Effect.provide(layer));
  });
});
