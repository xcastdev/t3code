// @effect-diagnostics nodeBuiltinImport:off - Plugin backends run outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import {
  definePluginBackend,
  materializeAsset,
  type TopicEmitter,
} from "@t3tools/plugin-sdk/backend";

import hello from "./hello.txt";

const children = new Set<NodeChildProcess.ChildProcess>();
const tickListeners = new Set<TopicEmitter>();
let pongs = 0;

const objectInput = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};

definePluginBackend({
  operations: {
    ping: async (input, ctx) => ({
      message: typeof objectInput(input).message === "string" ? objectInput(input).message : "ping",
      caller: ctx.caller,
    }),
    pong: async () => {
      pongs += 1;
      for (const emit of tickListeners) emit.batch([{ pongs }], String(pongs));
      return { pongs };
    },
    spawn_child: async (input) => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1 << 30)"],
        { stdio: "ignore" },
      );
      if (objectInput(input).untracked !== true) {
        children.add(child);
        child.on("exit", () => children.delete(child));
      }
      return { pid: child.pid };
    },
    log: async (input, ctx) => {
      const lines = objectInput(input).lines;
      const count = typeof lines === "number" && lines > 0 ? lines : 0;
      for (let index = 0; index < count; index += 1) ctx.log(`line ${index}`);
      return { lines: count };
    },
    crash: async () => process.exit(3),
    big: async (input) => {
      const bytes = objectInput(input).bytes;
      return { data: "x".repeat(typeof bytes === "number" && bytes > 0 ? bytes : 0) };
    },
    asset: async () => {
      const path = await materializeAsset("hello.txt", hello);
      return { path, text: await NodeFSP.readFile(path, "utf8") };
    },
  },
  topics: {
    ticks: (_params, emit) => {
      emit.snapshot({ items: [{ pongs }], revision: String(pongs), cursor: "start" });
      tickListeners.add(emit);
      return () => tickListeners.delete(emit);
    },
  },
  // Awaiting each exit lets Node reap the child, so its pid is gone once the worker exits.
  onStop: async () => {
    await Promise.all(
      [...children].map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
            child.kill("SIGKILL");
          }),
      ),
    );
  },
});
