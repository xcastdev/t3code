import { describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import * as OpenCodeExternalMcpCoordinator from "./OpenCodeExternalMcpCoordinator.ts";

const TestLayer = OpenCodeExternalMcpCoordinator.layer.pipe(Layer.provideMerge(NodeServices.layer));

const acquireInput = (directory: string) => ({
  target: {
    serverUrl: "https://opencode.example.test/",
    directory,
  },
  environmentId: EnvironmentId.make("environment-test"),
  providerInstanceId: ProviderInstanceId.make("opencode-test"),
  threadId: ThreadId.make(`thread-${directory}`),
});

describe("OpenCodeExternalMcpCoordinator", () => {
  it.layer(TestLayer)("allows one lease per canonical URL and directory", (it) => {
    it.effect("normalizes equivalent URLs but keeps directories independent", () =>
      Effect.gen(function* () {
        const coordinator = yield* OpenCodeExternalMcpCoordinator.OpenCodeExternalMcpCoordinator;
        const first = yield* coordinator.acquire(acquireInput("/workspace/one"));
        const sameTarget = yield* Effect.exit(
          coordinator.acquire({
            ...acquireInput("/workspace/one"),
            target: { serverUrl: "https://opencode.example.test", directory: "/workspace/one" },
            threadId: ThreadId.make("other-thread"),
          }),
        );
        const differentDirectory = yield* coordinator.acquire(acquireInput("/workspace/two"));

        expect(first.target.serverUrl).toBe("https://opencode.example.test/");
        expect(Exit.isFailure(sameTarget)).toBe(true);
        expect(differentDirectory.target.directory).toBe("/workspace/two");
      }),
    );
  });

  it.layer(TestLayer)("does not let a stale release remove a replacement lease", (it) => {
    it.effect("compares the complete lease identity", () =>
      Effect.gen(function* () {
        const coordinator = yield* OpenCodeExternalMcpCoordinator.OpenCodeExternalMcpCoordinator;
        const original = yield* coordinator.acquire(acquireInput("/workspace/one"));
        yield* coordinator.release(original);
        const replacement = yield* coordinator.acquire(acquireInput("/workspace/one"));

        yield* coordinator.release(original);

        expect(yield* coordinator.isCurrent(replacement)).toBe(true);
        const blocked = yield* Effect.exit(
          coordinator.acquire({
            ...acquireInput("/workspace/one"),
            threadId: ThreadId.make("third-thread"),
          }),
        );
        expect(Exit.isFailure(blocked)).toBe(true);
      }),
    );
  });
});
