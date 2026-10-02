import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Schema from "effect/Schema";
import { describe, expect, vi } from "vite-plus/test";
import { makePiLocalTools, piLocalToolDefinitions } from "./PiLocalTools.ts";
import type { PiSdkWorkerOptions } from "./PiWorker.ts";

const sdkDirectory = new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent"))
  .pathname;
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs
    .makeTempDirectoryScoped({ prefix: "pi-local-tools-" })
    .pipe(Effect.flatMap(fs.realPath));
  const previousPackageDirectory = process.env.PI_PACKAGE_DIR;
  process.env.PI_PACKAGE_DIR = sdkDirectory;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      vi.restoreAllMocks();
      if (previousPackageDirectory === undefined) delete process.env.PI_PACKAGE_DIR;
      else process.env.PI_PACKAGE_DIR = previousPackageDirectory;
    }),
  );
  const tools = yield* Effect.promise(() => makePiLocalTools(cwd));
  return { fs, cwd, tools };
});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodeInput = Schema.decodeSync(Schema.JsonObject);
const decodeValidatedInput = Schema.decodeUnknownSync(Schema.JsonObject);
const signal = () => new AbortController().signal;
const ToolResult = Schema.Struct({
  kind: Schema.Literal("json"),
  value: Schema.Struct({
    content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
    details: Schema.optional(Schema.JsonObject),
    structuredContent: Schema.optional(Schema.JsonObject),
  }),
});
const decodeResult = Schema.decodeUnknownSync(ToolResult);
const content = (result: unknown) =>
  decodeResult(result)
    .value.content.map((part) => part.text)
    .join("\n");

describe("Pi child-local native SDK tools", () => {
  it.effect("constructs only the four fixed capabilities without file actions or fetch", () =>
    Effect.gen(function* () {
      const { fs, cwd } = yield* fixture;
      const fetch = vi.spyOn(globalThis, "fetch");
      const prepared = yield* Effect.promise(() => makePiLocalTools(cwd));
      const local: PiSdkWorkerOptions["localTools"] = prepared.localTools;
      expect(prepared.tools).toBe(piLocalToolDefinitions);
      expect(Object.keys(local)).toEqual(["read", "write", "edit", "bash"]);
      expect(prepared.tools.map(({ name, capabilityId }) => ({ name, capabilityId }))).toEqual([
        { name: "read", capabilityId: "pi.read" },
        { name: "write", capabilityId: "pi.write" },
        { name: "edit", capabilityId: "pi.edit" },
        { name: "bash", capabilityId: "pi.bash" },
      ]);
      expect(Object.hasOwn(local, "grep")).toBe(false);
      expect(Object.hasOwn(local, "codemode")).toBe(false);
      expect(yield* fs.readDirectory(cwd)).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
      for (const tool of prepared.tools) {
        expect(tool.parameters.type).toBe("object");
        expect(tool.parameters.additionalProperties).toBe(false);
        expect(Buffer.byteLength(encodeJson(tool.parameters))).toBeLessThan(65_536);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect(
    "consumes the advertised parent schemas through the actual SDK argument validator",
    () =>
      Effect.gen(function* () {
        const { fs, cwd, tools } = yield* fixture;
        const { Type, validateToolArguments } = yield* Effect.promise(
          () => import("@earendil-works/pi-ai"),
        );
        const calls = [
          { name: "write" as const, args: { path: "parent-schema.txt", content: "before" } },
          { name: "read" as const, args: { path: "parent-schema.txt" } },
          {
            name: "edit" as const,
            args: { path: "parent-schema.txt", edits: [{ oldText: "before", newText: "after" }] },
          },
          { name: "bash" as const, args: { command: "printf 'parent-schema-marker'" } },
        ];
        const outputs: string[] = [];
        for (const call of calls) {
          const definition = piLocalToolDefinitions.find((tool) => tool.name === call.name);
          if (!definition) throw Error("MISSING_PARENT_DEFINITION");
          // This is the frozen worker's trusted JSON-schema adapter, exercised by the
          // pinned SDK validator before invoking the actual native execution helper.
          const sdkTool = {
            ...definition,
            parameters: Type.Unsafe<Schema.JsonObject>(definition.parameters),
          };
          const validated: unknown = validateToolArguments(sdkTool, {
            type: "toolCall",
            id: call.name,
            name: call.name,
            arguments: call.args,
          });
          const input = decodeValidatedInput(validated);
          outputs.push(
            content(yield* Effect.promise(() => tools.localTools[call.name](input, signal()))),
          );
          expect(() =>
            validateToolArguments(sdkTool, {
              type: "toolCall",
              id: call.name,
              name: call.name,
              arguments: { ...call.args, unexpected: true },
            }),
          ).toThrow("Validation failed");
        }
        expect(outputs[1]).toBe("before");
        expect(outputs[3]).toBe("parent-schema-marker");
        expect(yield* fs.readFileString(`${cwd}/parent-schema.txt`)).toBe("after");
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("requires trusted metadata setup and an explicit canonical absolute cwd", () =>
    Effect.gen(function* () {
      const { cwd } = yield* fixture;
      delete process.env.PI_PACKAGE_DIR;
      yield* Effect.promise(() => expect(makePiLocalTools(cwd)).rejects.toThrow("UNAVAILABLE"));
      process.env.PI_PACKAGE_DIR = sdkDirectory;
      for (const invalid of [
        "",
        ".",
        "workspace",
        "/workspace/../other",
        "/workspace//other",
        "/workspace/",
        "/workspace/./other",
      ])
        yield* Effect.promise(() =>
          expect(makePiLocalTools(invalid)).rejects.toThrow("INVALID_INPUT"),
        );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("writes parent directories, reads paged text and applies native disjoint edits", () =>
    Effect.gen(function* () {
      const { fs, cwd, tools } = yield* fixture;
      const written = yield* Effect.promise(() =>
        tools.localTools.write(
          { path: "nested/example.txt", content: "one\ntwo\nthree\n" },
          signal(),
        ),
      );
      expect(content(written)).toBe("Successfully wrote to nested/example.txt");
      expect(yield* fs.readFileString(`${cwd}/nested/example.txt`)).toBe("one\ntwo\nthree\n");
      expect(
        content(
          yield* Effect.promise(() =>
            tools.localTools.read({ path: "nested/example.txt", offset: 2, limit: 1 }, signal()),
          ),
        ),
      ).toBe("two\n\n[2 more lines in file. Use offset=3 to continue.]");
      const edited = decodeResult(
        yield* Effect.promise(() =>
          tools.localTools.edit(
            {
              path: "nested/example.txt",
              edits: [
                { oldText: "one", newText: "first" },
                { oldText: "three", newText: "last" },
              ],
            },
            signal(),
          ),
        ),
      );
      expect(content(edited)).toBe("Successfully replaced 2 block(s) in nested/example.txt.");
      expect(edited.value.details?.patch).toContain("+first");
      expect(edited.value.details?.firstChangedLine).toBe(1);
      expect(yield* fs.readFileString(`${cwd}/nested/example.txt`)).toBe("first\ntwo\nlast\n");
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("retains native line endings and refuses ambiguous edits without mutation", () =>
    Effect.gen(function* () {
      const { fs, cwd, tools } = yield* fixture;
      yield* fs.writeFileString(`${cwd}/example.txt`, "same\r\nsame\r\nunique\r\n");
      yield* Effect.promise(() =>
        expect(
          tools.localTools.edit(
            { path: "example.txt", edits: [{ oldText: "same", newText: "other" }] },
            signal(),
          ),
        ).rejects.toThrow("TOOL_FAILURE"),
      );
      expect(yield* fs.readFileString(`${cwd}/example.txt`)).toBe("same\r\nsame\r\nunique\r\n");
      yield* Effect.promise(() =>
        tools.localTools.edit(
          { path: "example.txt", edits: [{ oldText: "unique", newText: "changed" }] },
          signal(),
        ),
      );
      expect(yield* fs.readFileString(`${cwd}/example.txt`)).toBe("same\r\nsame\r\nchanged\r\n");
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("rejects an actual native image attachment through the text-only worker boundary", () =>
    Effect.gen(function* () {
      const { fs, cwd, tools } = yield* fixture;
      yield* fs.writeFile(
        `${cwd}/image.png`,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRyoAAAAASUVORK5CYII=",
          "base64",
        ),
      );
      yield* Effect.promise(() =>
        expect(tools.localTools.read({ path: "image.png" }, signal())).rejects.toThrow(
          /^TOOL_FAILURE$/,
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect.each([
    { name: "read" as const, args: { path: "absent", unexpected: true } },
    { name: "read" as const, args: { path: "absent", offset: 0 } },
    { name: "read" as const, args: { path: "absent", limit: 1.5 } },
    { name: "write" as const, args: { path: "created", content: 42 } },
    { name: "write" as const, args: { path: "created", content: "é".repeat(60_000) } },
    { name: "edit" as const, args: { path: "absent", oldText: "a", newText: "b" } },
    { name: "edit" as const, args: { path: "absent", edits: [] } },
    {
      name: "edit" as const,
      args: { path: "absent", edits: [{ oldText: "a", newText: "b", extra: true }] },
    },
    { name: "edit" as const, args: { path: "absent", edits: "[]" } },
    { name: "bash" as const, args: { command: "printf invalid > created", timeout: 0 } },
    { name: "bash" as const, args: { command: "printf invalid > created", timeout: 2_147_484 } },
    {
      name: "bash" as const,
      args: { command: "printf invalid > created", shellPath: "/bin/bash" },
    },
  ])("rejects malformed or excess $name arguments before side effects", ({ name, args }) =>
    Effect.gen(function* () {
      const { fs, cwd, tools } = yield* fixture;
      const input = decodeInput(args);
      yield* Effect.promise(() =>
        expect(tools.localTools[name](input, signal())).rejects.toThrow("INVALID_INPUT"),
      );
      expect(yield* fs.readDirectory(cwd)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("propagates already aborted signals to all four executions without side effects", () =>
    Effect.gen(function* () {
      const { fs, cwd, tools } = yield* fixture;
      const canceled = new AbortController();
      canceled.abort();
      const calls = [
        tools.localTools.read({ path: "absent" }, canceled.signal),
        tools.localTools.write({ path: "created", content: "bad" }, canceled.signal),
        tools.localTools.edit(
          { path: "absent", edits: [{ oldText: "a", newText: "b" }] },
          canceled.signal,
        ),
        tools.localTools.bash({ command: "printf bad > created" }, canceled.signal),
      ];
      for (const call of calls)
        yield* Effect.promise(() => expect(call).rejects.toThrow("CANCELED"));
      expect(yield* fs.readDirectory(cwd)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("redacts native filesystem failures", () =>
    Effect.gen(function* () {
      const { tools } = yield* fixture;
      yield* Effect.promise(() =>
        expect(tools.localTools.read({ path: "absent" }, signal())).rejects.toThrow(
          /^TOOL_FAILURE$/,
        ),
      );
      yield* Effect.promise(() =>
        expect(
          tools.localTools.edit(
            { path: "absent", edits: [{ oldText: "a", newText: "b" }] },
            signal(),
          ),
        ).rejects.toThrow(/^TOOL_FAILURE$/),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("returns actual bash output and exit details from the explicit cwd", () =>
    Effect.gen(function* () {
      const { fs, cwd, tools } = yield* fixture;
      const result = decodeResult(
        yield* Effect.promise(() =>
          tools.localTools.bash(
            { command: "printf 'native-marker\n'; printf 'owned' > bash-created.txt; pwd" },
            signal(),
          ),
        ),
      );
      expect(content(result)).toBe(`native-marker\n${cwd}\n`);
      expect(result.value.structuredContent?.exit_code).toBe(0);
      expect(result.value.structuredContent?.output).toBe(`native-marker\n${cwd}\n`);
      expect(yield* fs.readFileString(`${cwd}/bash-created.txt`)).toBe("owned");
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("refuses a native bash isError result as a successful worker tool result", () =>
    Effect.gen(function* () {
      const { tools } = yield* fixture;
      yield* Effect.promise(() =>
        expect(
          tools.localTools.bash({ command: "printf 'secret-output'; exit 7" }, signal()),
        ).rejects.toThrow(/^TOOL_FAILURE$/),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect.skipIf(process.env.PI_LOCAL_TOOLS_LINUX_GATE !== "1")(
    "aborts actual native bash and its owned process-group descendant on a receipt",
    () =>
      Effect.gen(function* () {
        const { fs, cwd, tools } = yield* fixture;
        expect(yield* HostProcessPlatform).toBe("linux");
        const canceled = new AbortController();
        const receipt = Promise.withResolvers<void>();
        const onReceipt = () => {
          canceled.abort();
          receipt.resolve();
        };
        process.once("SIGUSR2", onReceipt);
        try {
          const execution = tools.localTools.bash(
            {
              command: `mkfifo wait.fifo; /bin/bash -c 'read -r marker < wait.fifo' & descendant=$!; printf '%s %s\n' "$$" "$descendant" > process-receipt; kill -USR2 ${process.pid}; wait`,
            },
            canceled.signal,
          );
          const rejected = expect(execution).rejects.toThrow(/^CANCELED$/);
          yield* Effect.promise(() => receipt.promise);
          yield* Effect.promise(() => rejected);
          const pids = (yield* fs.readFileString(`${cwd}/process-receipt`)).trim().split(" ");
          expect(pids).toHaveLength(2);
          for (const pid of pids) {
            expect(pid).toMatch(/^[1-9][0-9]+$/);
            const state = yield* fs.readFileString(`/proc/${pid}/stat`).pipe(
              Effect.catchIf(
                (error) => error.reason._tag === "NotFound",
                () => Effect.void,
              ),
            );
            // The SDK kills the group but cannot join reaping of orphaned grandchildren.
            // A zombie is terminated, not an owned-descendant drain receipt.
            if (state !== undefined)
              expect(state.slice(state.lastIndexOf(")") + 2, state.lastIndexOf(")") + 3)).toBe("Z");
          }
        } finally {
          process.removeListener("SIGUSR2", onReceipt);
          canceled.abort();
        }
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
});
