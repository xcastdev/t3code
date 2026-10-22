// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import type * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";
import { acquireNativeWatch } from "./SkillWatchService.ts";

const state = vi.hoisted((): { watcher?: NodeFS.FSWatcher } => ({}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: (_root: string, _options: NodeFS.WatchOptions, listener: NodeFS.WatchListener<string>) => {
    if (state.watcher === undefined) throw new Error("Watcher fixture is unavailable.");
    state.watcher.on("change", listener);
    return state.watcher;
  },
}));

it.effect("bounds a native event burst while preserving relevant invalidation", () =>
  Effect.gen(function* () {
    const watcher: NodeFS.FSWatcher = Object.assign(new NodeEvents.EventEmitter(), {
      close: () => {
        watcher.emit("close");
      },
      ref: () => watcher,
      unref: () => watcher,
    });
    state.watcher = watcher;
    const acquired = yield* acquireNativeWatch("/workspace", (event) =>
      event.path.startsWith("skills/"),
    );
    for (let index = 0; index < 10_000; index++)
      watcher.emit("change", "change", `skills/${index}`);
    watcher.emit("change", "change", "unrelated.sqlite");
    watcher.close();
    assert.deepEqual(yield* Stream.runCollect(acquired.events), [{ path: "skills/9999" }]);
  }).pipe(Effect.scoped),
);
