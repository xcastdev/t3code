import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { describe, expect, vi } from "vite-plus/test";
import * as BashIsolation from "./PiBashToolIsolation.ts";
import {
  makePiIsolatedLocalTools,
  makePiLocalTools,
  piLocalToolDefinitions,
} from "./PiLocalTools.ts";
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
  it.effect.each(["read", "write", "edit"] as const)(
    "confines native $0 filesystem operations to the admitted workspace",
    (name) =>
      Effect.gen(function* () {
        const { fs, cwd, tools } = yield* fixture;
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "pi-outside-file-boundary-" });
        const secret = outside + "/private.txt";
        yield* fs.writeFileString(secret, "private-original");
        const nodeFS = process.getBuiltinModule("fs").promises;
        const nodePath = process.getBuiltinModule("path");
        yield* Effect.promise(() => nodeFS.symlink(secret, cwd + "/file-alias"));
        yield* Effect.promise(() => nodeFS.symlink(outside, cwd + "/directory-alias"));
        yield* Effect.promise(() => nodeFS.link(secret, cwd + "/hard-alias"));
        yield* fs.writeFileString(cwd + "/.git", "protected-metadata");
        const paths = [
          secret,
          "@" + secret,
          process.getBuiltinModule("url").pathToFileURL(secret).href,
          nodePath.relative(cwd, secret),
          "file-alias",
          "directory-alias/private.txt",
          "hard-alias",
          ".git",
        ];
        for (const path of paths) {
          const args =
            name === "read"
              ? { path }
              : name === "write"
                ? { path, content: "altered" }
                : { path, edits: [{ oldText: "private-original", newText: "altered" }] };
          const outcome = yield* Effect.promise(() =>
            tools.localTools[name](decodeInput(args), signal()).then(
              (result) => ({ ok: true, result }),
              (error: unknown) => ({ ok: false, error: String(error) }),
            ),
          );
          const evidence = process.env.PI_LOCAL_TOOLS_EVIDENCE_DIRECTORY;
          if (evidence)
            yield* fs.writeFileString(
              evidence + "/filesystem-" + name + ".json",
              encodeJson({ name, path, outcome, outsideBytes: yield* fs.readFileString(secret) }),
            );
          expect(outcome.ok).toBe(false);
          expect(yield* fs.readFileString(secret)).toBe("private-original");
        }
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("replaces an admitted file without mutating a hardlink created after validation", () =>
    Effect.gen(function* () {
      const { fs, cwd, tools } = yield* fixture;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "pi-late-hardlink-" });
      yield* fs.writeFileString(cwd + "/file.txt", "original");
      const nodeFS = process.getBuiltinModule("fs").promises;
      yield* Effect.promise(() => nodeFS.chmod(cwd + "/file.txt", 0o754));
      const rename = nodeFS.rename;
      let aliased = false;
      vi.spyOn(nodeFS, "rename").mockImplementation(async (...args) => {
        if (typeof args[0] === "string" && args[0].includes("/.t3-pi-")) {
          await nodeFS.link(cwd + "/file.txt", outside + "/late-alias");
          aliased = true;
        }
        return rename(...args);
      });
      yield* Effect.promise(() =>
        tools.localTools.write({ path: cwd + "/file.txt", content: "replacement" }, signal()),
      );
      expect(aliased).toBe(true);
      expect(yield* fs.readFileString(outside + "/late-alias")).toBe("original");
      expect(yield* fs.readFileString(cwd + "/file.txt")).toBe("replacement");
      expect((yield* Effect.promise(() => nodeFS.stat(cwd + "/file.txt"))).mode & 0o777).toBe(
        0o754,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect.each(["read", "write", "edit"] as const)(
    "rejects a directory swap after native $0 opens its admitted descriptor",
    (name) =>
      Effect.gen(function* () {
        const { fs, cwd, tools } = yield* fixture;
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "pi-swapped-directory-" });
        yield* fs.makeDirectory(cwd + "/nested");
        yield* fs.writeFileString(cwd + "/nested/file.txt", "original");
        yield* fs.writeFileString(outside + "/file.txt", "private");
        const nodeFS = process.getBuiltinModule("fs").promises;
        const open = nodeFS.open;
        let swapped = false;
        vi.spyOn(nodeFS, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (
            !swapped &&
            typeof args[0] === "string" &&
            args[0].startsWith("/proc/self/fd/") &&
            args[0].endsWith("/file.txt")
          ) {
            swapped = true;
            await nodeFS.rename(cwd + "/nested", cwd + "/held-original");
            await nodeFS.symlink(outside, cwd + "/nested");
          }
          return handle;
        });
        const args =
          name === "read"
            ? { path: "nested/file.txt" }
            : name === "write"
              ? { path: "nested/file.txt", content: "altered" }
              : { path: "nested/file.txt", edits: [{ oldText: "original", newText: "altered" }] };
        yield* Effect.promise(() =>
          expect(tools.localTools[name](decodeInput(args), signal())).rejects.toThrow(
            "TOOL_FAILURE",
          ),
        );
        expect(swapped).toBe(true);
        expect(yield* fs.readFileString(outside + "/file.txt")).toBe("private");
        expect(yield* fs.readFileString(cwd + "/held-original/file.txt")).toBe("original");
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("drains an admitted native read before cancellation releases its descriptors", () =>
    Effect.gen(function* () {
      const { fs, cwd, tools } = yield* fixture;
      yield* fs.writeFileString(cwd + "/held-read.txt", "workspace-content");
      const nodeFS = process.getBuiltinModule("fs").promises;
      const open = nodeFS.open;
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      let readDrained = false;
      let descriptorClosed = false;
      vi.spyOn(nodeFS, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (typeof args[0] === "string" && args[0].endsWith("/held-read.txt")) {
          const readFile = handle.readFile.bind(handle);
          vi.spyOn(handle, "readFile").mockImplementation(async (...readArgs) => {
            const bytes = await readFile(...readArgs);
            entered.resolve();
            await released.promise;
            readDrained = true;
            return bytes;
          });
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementation(async () => {
            expect(readDrained).toBe(true);
            await close();
            descriptorClosed = true;
          });
        }
        return handle;
      });
      const controller = new AbortController();
      const outcome = tools.localTools.read({ path: "held-read.txt" }, controller.signal).then(
        () => "unexpected success",
        (error: unknown) => String(error),
      );
      yield* Effect.promise(() => entered.promise);
      controller.abort();
      released.resolve();
      expect(yield* Effect.promise(() => outcome)).toContain("CANCELED");
      expect(readDrained).toBe(true);
      expect(descriptorClosed).toBe(true);
      expect(yield* fs.readFileString(cwd + "/held-read.txt")).toBe("workspace-content");
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

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
          if (call.name === "bash") {
            yield* Effect.promise(() =>
              expect(tools.localTools.bash(input, signal())).rejects.toThrow("UNAVAILABLE"),
            );
          } else {
            outputs.push(
              content(yield* Effect.promise(() => tools.localTools[call.name](input, signal()))),
            );
          }
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

  it.effect("fails Bash closed without starting an ordinary SDK shell", () =>
    Effect.gen(function* () {
      const { fs, cwd, tools } = yield* fixture;
      const childProcess = process.getBuiltinModule("child_process");
      const spawn = vi.spyOn(childProcess, "spawn");
      yield* Effect.promise(() =>
        expect(
          tools.localTools.bash({ command: "printf ordinary > bash-created.txt" }, signal()),
        ).rejects.toThrow(/^UNAVAILABLE$/),
      );
      expect(spawn).not.toHaveBeenCalled();
      expect(yield* fs.readDirectory(cwd)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
});

// Synthetic kernel metadata exercises the fixed consumer's mode derivation; native
// entry gates below use the unchanged process owner and its actual readonly mounts.
const factoryFixture = Effect.gen(function* () {
  const { fs, cwd } = yield* fixture;
  const metadata = cwd + "/mountinfo";
  const files = process.getBuiltinModule("fs").promises;
  const open = files.open.bind(files);
  const handles: Awaited<ReturnType<typeof files.open>>[] = [];
  vi.spyOn(files, "open").mockImplementation(async (...args) => {
    if (args[0] === "/proc/self/mountinfo") {
      const handle = await open(metadata, args[1], args[2]);
      handles.push(handle);
      return handle;
    }
    return open(...args);
  });
  let closed = false;
  const close = vi.fn(async () => {
    closed = true;
  });
  const exec = vi.fn<import("@earendil-works/pi-coding-agent").BashOperations["exec"]>(
    async (_command, _cwd, options) => {
      if (closed) throw Error("UNAVAILABLE");
      options.onData(Buffer.from("owned-marker"));
      return { exitCode: 0 };
    },
  );
  const isolation = vi
    .spyOn(BashIsolation, "makePiBashToolIsolation")
    .mockResolvedValue({ operations: { exec }, close });
  return { fs, metadata, handles, close, exec, isolation };
});

describe("fixed Pi isolated tool factory", () => {
  it.effect.each(["ro", "rw"] as const)(
    "derives the actual %s mount mode and uses only owned operations",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* factoryFixture;
        yield* f.fs.writeFileString(
          f.metadata,
          `1 9 0:1 / / ro - tmpfs tmpfs ro\n2 1 0:2 / /workspace ${mode} - tmpfs tmpfs rw\n`,
        );
        const tools = yield* Effect.promise(() => makePiIsolatedLocalTools());
        expect(f.isolation).toHaveBeenCalledWith({
          localOperations: { exec: expect.any(Function) },
          workspaceAccess: mode === "ro" ? "readonly" : "readwrite",
          protectedWorkspacePaths: ["/workspace/.git"],
        });
        expect(
          content(
            yield* Effect.promise(() =>
              tools.localTools.bash({ command: "printf owned", timeout: 0.3 }, signal()),
            ),
          ),
        ).toBe("owned-marker");
        expect(f.exec).toHaveBeenCalledTimes(1);
        expect(f.exec.mock.calls[0]?.slice(0, 2)).toEqual(["printf owned", "/workspace"]);
        expect(f.exec.mock.calls[0]?.[2].timeout).toBe(0.3);
        yield* Effect.promise(tools.close);
        yield* Effect.promise(() =>
          expect(tools.localTools.bash({ command: "printf later" }, signal())).rejects.toThrow(
            "UNAVAILABLE",
          ),
        );
        expect(f.close).toHaveBeenCalledTimes(1);
        expect(f.handles.every((handle) => handle.fd === -1)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect.each([
    "1 9 0:1 / / ro - tmpfs tmpfs ro\n",
    "1 9 0:1 / /workspace rw,rw - tmpfs tmpfs rw\n",
    "1 9 0:1 / /workspace ro,rw - tmpfs tmpfs rw\n",
    "1 9 0:1 / /workspace nosuid - tmpfs tmpfs rw\n",
    "1 9 0:1 / /workspace rw - tmpfs tmpfs rw\n2 9 0:2 / /workspace ro - tmpfs tmpfs ro\n",
    "1 9 0:1 / /workspace rw - tmpfs tmpfs rw\n1 9 0:2 / /other ro - tmpfs tmpfs ro\n",
    "1 malformed workspace rw\n",
    "x".repeat(65_537),
    Array.from(
      { length: 513 },
      (_, index) => `${index + 1} 9 0:1 / /other rw - tmpfs tmpfs rw`,
    ).join("\n"),
  ])("rejects absent, ambiguous or unbounded mount metadata before ownership", (mountinfo) =>
    Effect.gen(function* () {
      const f = yield* factoryFixture;
      yield* f.fs.writeFileString(f.metadata, mountinfo);
      yield* Effect.promise(() =>
        expect(makePiIsolatedLocalTools()).rejects.toThrow("UNAVAILABLE"),
      );
      expect(f.isolation).not.toHaveBeenCalled();
      expect(f.exec).not.toHaveBeenCalled();
      expect(f.handles.every((handle) => handle.fd === -1)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("joins owned close if file-tool construction fails after admission", () =>
    Effect.gen(function* () {
      const f = yield* factoryFixture;
      yield* f.fs.writeFileString(f.metadata, "1 9 0:1 / /workspace rw - tmpfs tmpfs rw\n");
      vi.spyOn(process.getBuiltinModule("os"), "platform").mockReturnValue("darwin");
      yield* Effect.promise(() =>
        expect(makePiIsolatedLocalTools()).rejects.toThrow("UNAVAILABLE"),
      );
      expect(f.isolation).toHaveBeenCalledTimes(1);
      expect(f.close).toHaveBeenCalledTimes(1);
      expect(f.exec).not.toHaveBeenCalled();
      expect(f.handles.every((handle) => handle.fd === -1)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );
});
