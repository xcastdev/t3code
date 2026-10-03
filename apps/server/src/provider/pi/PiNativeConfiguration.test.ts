// @effect-diagnostics nodeBuiltinImport:off - Real disposable descriptor races and cleanup are observed without native credential access.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { describe, expect, vi } from "vite-plus/test";

import {
  inspectPiNativeConfiguration,
  readPiSavedLiteralCredential,
} from "./PiNativeConfiguration.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, open: vi.fn(actual.open) };
});

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const provider = "command-code";
const model = "inclusionai/ling-3.1-flash:free";
const endpoint = "https://api.commandcode.ai/provider/v1/chat/completions";
const baseUrl = "https://api.commandcode.ai/provider/v1";
const catalogue = {
  source: "https://api.commandcode.ai/provider/v1/models",
  fetchedAt: "2026-10-01T06:39:55.501Z",
  selectedEntry: {
    id: model,
    object: "model",
    created: 1790836795,
    owned_by: provider,
    name: "Ling 3.1 Flash",
    context_length: 262144,
    supported_endpoints: ["/chat/completions"],
  },
};
const limits = { maxInputTokens: 20000, maxOutputTokens: 2048, deadlineMs: 60000 };
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-native-config-" });
  const agentDirectory = yield* fs.realPath(root);
  const write = (name: string, value: unknown) =>
    fs.writeFileString(path.join(agentDirectory, name), encode(value));
  const input = {
    agentDirectory,
    selectedModel: { provider, model },
    catalogue,
    limits,
    nodeVersion: "22.19.0",
  };
  return { fs, path, agentDirectory, write, input };
});

describe("Pi native configuration", () => {
  it.effect(
    "uses the explicit current catalogue and policy without reading auth or native defaults",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.write("settings.json", {
          defaultProvider: "cursor",
          defaultModel: "cursor/composer",
        });
        yield* f.write("models.json", { providers: { cursor: { apiKey: "!not-executed" } } });
        yield* f.fs.makeDirectory(f.path.join(f.agentDirectory, "auth.json"));
        const before = yield* f.fs.readDirectory(f.agentDirectory);
        const result = yield* inspectPiNativeConfiguration(f.input);
        expect(result).toMatchObject({
          provider,
          model,
          endpoint,
          api: "openai-completions",
          contextWindow: 262144,
          maxOutputTokens: 2048,
          advertisedMaxOutputTokens: null,
          reasoning: false,
          input: ["text"],
          cost: "unknown",
          catalogue: { source: catalogue.source, fetchedAt: catalogue.fetchedAt },
        });
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.input)).toBe(true);
        expect(Object.isFrozen(result.catalogue)).toBe(true);
        expect(yield* f.fs.readDirectory(f.agentDirectory)).toEqual(before);
        expect(encode(result)).not.toContain("apiKey");
        expect(encode(result)).not.toContain("auth.json");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts compatible selected native metadata while ignoring other model entries", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("models.json", {
        providers: {
          [provider]: {
            baseUrl,
            api: "openai-completions",
            models: [
              { id: "another-model", apiKey: "!ignored" },
              {
                id: model,
                contextWindow: 262144,
                maxTokens: 2048,
                reasoning: false,
                input: ["text"],
              },
            ],
          },
        },
      });
      expect((yield* inspectPiNativeConfiguration(f.input)).model).toBe(model);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads hand-edited JSONC model metadata without rewriting it", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const contents = '{\n// native configuration\n"providers": {"command-code": {},},\n}';
      const target = f.path.join(f.agentDirectory, "models.json");
      yield* f.fs.writeFileString(target, contents);
      expect((yield* inspectPiNativeConfiguration(f.input)).model).toBe(model);
      expect(yield* f.fs.readFileString(target)).toBe(contents);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "fails closed on missing or conflicting catalogue, route, limits and Node support",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const invalid = [
          { catalogue: undefined },
          { catalogue: { ...catalogue, source: "https://other.invalid/models" } },
          { catalogue: { ...catalogue, fetchedAt: "invalid" } },
          {
            catalogue: {
              ...catalogue,
              selectedEntry: { ...catalogue.selectedEntry, id: "paid-model" },
            },
          },
          {
            catalogue: {
              ...catalogue,
              selectedEntry: { ...catalogue.selectedEntry, owned_by: "other" },
            },
          },
          {
            catalogue: {
              ...catalogue,
              selectedEntry: { ...catalogue.selectedEntry, context_length: 0 },
            },
          },
          {
            catalogue: {
              ...catalogue,
              selectedEntry: { ...catalogue.selectedEntry, supported_endpoints: ["/responses"] },
            },
          },
          { selectedModel: { provider: "openai", model } },
          { selectedModel: { provider, model: "inclusionai/ling-3.1-flash" } },
          { limits: { ...limits, maxOutputTokens: 65537 } },
          { limits: { ...limits, maxInputTokens: 1000001 } },
          { limits: { ...limits, deadlineMs: 300001 } },
          { limits: { ...limits, maxInputTokens: 262145 } },
          { limits: { ...limits, maxOutputTokens: 0 } },
          { nodeVersion: "22.18.9" },
          { nodeVersion: "22.19.0-rc.1" },
          { nodeVersion: "9999999999999999999999.0.0" },
        ];
        for (const change of invalid) {
          const error = yield* Effect.flip(inspectPiNativeConfiguration({ ...f.input, ...change }));
          expect(error._tag).toBe("PiNativeConfigurationUnavailable");
          expect(Object.keys(error)).not.toContain("cause");
        }
        for (const nodeVersion of ["22.19.0", "23.11.0", "24.10.0", "26.8.1"]) {
          expect((yield* inspectPiNativeConfiguration({ ...f.input, nodeVersion })).model).toBe(
            model,
          );
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "checks an advertised output ceiling without inventing one or claiming free billing",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const withOutput = (max_output_tokens: number) => ({
          ...catalogue,
          selectedEntry: {
            ...catalogue.selectedEntry,
            max_output_tokens,
            pricing: { input: 0, output: 0 },
          },
        });
        const result = yield* inspectPiNativeConfiguration({
          ...f.input,
          catalogue: withOutput(4096),
        });
        expect(result.advertisedMaxOutputTokens).toBe(4096);
        expect(result.maxOutputTokens).toBe(2048);
        expect(result.cost).toBe("unknown");
        yield* Effect.flip(
          inspectPiNativeConfiguration({ ...f.input, catalogue: withOutput(1024) }),
        );
        yield* Effect.flip(inspectPiNativeConfiguration({ ...f.input, catalogue: withOutput(0) }));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rejects selected native auth, headers, overrides, duplicate entries and conflicting dimensions",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const invalid = [
          { apiKey: "synthetic-key" },
          { headers: {} },
          { baseUrl: "https://other.invalid/v1" },
          { api: "openai-responses" },
          { env: {} },
          { modelOverrides: { [model]: {} } },
          { models: [{ id: model, headers: {} }] },
          { models: [{ id: model, compat: {} }] },
          { models: [{ id: model, cost: { input: 0 } }] },
          { models: [{ id: model, contextWindow: 131072 }] },
          { models: [{ id: model, maxTokens: 32768 }] },
          { models: [{ id: model, reasoning: true }] },
          { models: [{ id: model, input: ["text", "image"] }] },
          { models: [{ id: model }, { id: model }] },
        ];
        for (const configuration of invalid) {
          yield* f.write("models.json", { providers: { [provider]: configuration } });
          const error = yield* Effect.flip(inspectPiNativeConfiguration(f.input));
          expect(error.reason).toBe("native-configuration");
          expect(encode(error)).not.toContain("synthetic-key");
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rejects malformed, oversized, nonregular and linked native files without writing",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const modelsPath = f.path.join(f.agentDirectory, "models.json");
        for (const contents of ["{", " ".repeat(262145)]) {
          yield* f.fs.writeFileString(modelsPath, contents);
          yield* Effect.flip(inspectPiNativeConfiguration(f.input));
          expect(yield* f.fs.readFileString(modelsPath)).toBe(contents);
        }
        yield* f.fs.remove(modelsPath, { recursive: true });
        yield* f.fs.makeDirectory(modelsPath);
        yield* Effect.flip(inspectPiNativeConfiguration(f.input));
        yield* f.fs.remove(modelsPath, { recursive: true });
        const source = f.path.join(f.agentDirectory, "source.json");
        yield* f.fs.writeFileString(source, "{}");
        yield* f.fs.symlink(source, modelsPath);
        yield* Effect.flip(inspectPiNativeConfiguration(f.input));
        yield* f.fs.remove(source);
        yield* Effect.flip(inspectPiNativeConfiguration(f.input));
        yield* Effect.flip(inspectPiNativeConfiguration({ ...f.input, agentDirectory: "." }));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reopens only the saved selected-provider literal and returns it redacted", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("auth.json", {
        cursor: { type: "oauth", refresh: "ignored" },
        [provider]: { type: "api_key", key: "synthetic-one" },
      });
      const first = yield* readPiSavedLiteralCredential(f.agentDirectory);
      expect(Redacted.value(first)).toBe("synthetic-one");
      expect(String(first)).not.toContain("synthetic-one");
      yield* f.write("auth.json", { [provider]: { type: "api_key", key: "synthetic-two" } });
      expect(Redacted.value(yield* readPiSavedLiteralCredential(f.agentDirectory))).toBe(
        "synthetic-two",
      );
      yield* f.fs.remove(f.path.join(f.agentDirectory, "auth.json"));
      expect((yield* Effect.flip(readPiSavedLiteralCredential(f.agentDirectory))).reason).toBe(
        "credential-unavailable",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "never resolves command, environment, OAuth, options, invalid literals or malformed auth",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const invalid = [
          { type: "api_key", key: "!touch forbidden" },
          { type: "api_key", key: "$CMD_API_KEY" },
          { type: "api_key", key: "prefix-${CMD_API_KEY}" },
          { type: "api_key", key: "$$escaped" },
          { type: "api_key", key: "literal\r\nheader" },
          { type: "api_key", key: " literal" },
          { type: "api_key", key: "" },
          { type: "api_key", key: "x".repeat(4097) },
          { type: "api_key", key: "synthetic-key", env: {} },
          { type: "api_key", key: "synthetic-key", headers: {} },
          { type: "oauth", access: "synthetic-key" },
          {},
        ];
        for (const credential of invalid) {
          yield* f.write("auth.json", {
            [provider]: credential,
            other: { type: "api_key", key: "fallback" },
          });
          const error = yield* Effect.flip(readPiSavedLiteralCredential(f.agentDirectory));
          expect(error.reason).toBe("credential-unavailable");
          expect(encode(error)).not.toContain("synthetic-key");
          expect(encode(error)).not.toContain("fallback");
          expect(encode(error)).not.toContain("CMD_API_KEY");
        }
        yield* f.fs.writeFileString(f.path.join(f.agentDirectory, "auth.json"), "{synthetic-key");
        expect(
          encode(yield* Effect.flip(readPiSavedLiteralCredential(f.agentDirectory))),
        ).not.toContain("synthetic-key");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("rejects bounded-auth read failures without exposing file contents", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const target = f.path.join(f.agentDirectory, "auth.json");
      yield* f.fs.makeDirectory(target);
      yield* Effect.flip(readPiSavedLiteralCredential(f.agentDirectory));
      yield* f.fs.remove(target, { recursive: true });
      yield* f.fs.writeFileString(target, '"' + "synthetic-key".repeat(30000) + '"');
      const error = yield* Effect.flip(readPiSavedLiteralCredential(f.agentDirectory));
      expect(encode(error)).not.toContain("synthetic-key");
      yield* f.fs.remove(target);
      const source = f.path.join(f.agentDirectory, "other-auth.json");
      yield* f.write("other-auth.json", { [provider]: { type: "api_key", key: "synthetic-key" } });
      yield* f.fs.symlink(source, target);
      yield* Effect.flip(readPiSavedLiteralCredential(f.agentDirectory));
      const linkedDirectory = f.path.join(f.agentDirectory, "linked-directory");
      yield* f.fs.symlink(f.agentDirectory, linkedDirectory);
      yield* Effect.flip(readPiSavedLiteralCredential(linkedDirectory));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("Pi native configuration descriptor containment", () => {
  for (const replacement of ["file", "directory"] as const) {
    it.effect(`rejects a transient ${replacement} substitution before reading foreign bytes`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const original = { [provider]: { type: "api_key", key: "SYNTHETIC-OWN-000" } };
        const foreign = { [provider]: { type: "api_key", key: "SYNTHETIC-FOREIGN" } };
        yield* f.write("auth.json", original);
        const outside = yield* f.fs.makeTempDirectoryScoped({ prefix: "t3-pi-foreign-" });
        yield* f.fs.writeFileString(f.path.join(outside, "auth.json"), encode(foreign));
        const actual = yield* Effect.promise(() =>
          vi.importActual<typeof NodeFSP>("node:fs/promises"),
        );
        const target =
          replacement === "file" ? f.path.join(f.agentDirectory, "auth.json") : f.agentDirectory;
        const external = replacement === "file" ? f.path.join(outside, "auth.json") : outside;
        const saved = `${target}-saved`;
        let attacks = 0;
        let foreignReads = 0;
        const beforeOpen = async () => {
          attacks++;
          await actual.rename(target, saved);
          await actual.symlink(external, target);
        };
        const afterOpen = async () => {
          await actual.unlink(target);
          await actual.rename(saved, target);
        };
        const mockOpen = vi.mocked(NodeFSP.open);
        mockOpen.mockImplementation(async (...args) => {
          if (!String(args[0]).endsWith("/auth.json")) return actual.open(...args);
          await beforeOpen();
          try {
            const handle = await actual.open(...args);
            const read = handle.read.bind(handle);
            vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
              const result = await read(...readArgs);
              if (
                Buffer.from(
                  result.buffer.buffer,
                  result.buffer.byteOffset,
                  result.buffer.byteLength,
                )
                  .toString()
                  .includes("SYNTHETIC-FOREIGN")
              )
                foreignReads++;
              return result;
            });
            return handle;
          } finally {
            await afterOpen();
          }
        });
        // Keep the original Effect-backed reader under the identical real race for RED evidence.
        const legacyFs = FileSystem.make({
          ...f.fs,
          open: (name, options) =>
            name.endsWith("/auth.json")
              ? Effect.gen(function* () {
                  yield* Effect.promise(beforeOpen);
                  const file = yield* f.fs
                    .open(name, options)
                    .pipe(Effect.ensuring(Effect.promise(afterOpen)));
                  const read = file.read.bind(file);
                  vi.spyOn(file, "read").mockImplementation((buffer) =>
                    read(buffer).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          if (Buffer.from(buffer).toString().includes("SYNTHETIC-FOREIGN"))
                            foreignReads++;
                        }),
                      ),
                    ),
                  );
                  return file;
                })
              : f.fs.open(name, options),
        });
        const result = yield* readPiSavedLiteralCredential(f.agentDirectory).pipe(
          Effect.provideService(FileSystem.FileSystem, legacyFs),
          Effect.match({ onSuccess: () => "accepted", onFailure: (error) => error.reason }),
          Effect.ensuring(Effect.sync(() => mockOpen.mockImplementation(actual.open))),
        );
        expect(attacks).toBe(1);
        expect(foreignReads).toBe(0);
        expect(result).toBe("credential-unavailable");
        expect(yield* f.fs.readFileString(f.path.join(f.agentDirectory, "auth.json"))).toBe(
          encode(original),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
});

const interceptOpens = Effect.fn(function* (
  onOpen: (file: NodeFSP.FileHandle, path: string) => Promise<void>,
) {
  const actual = yield* Effect.promise(() => vi.importActual<typeof NodeFSP>("node:fs/promises"));
  const handles: NodeFSP.FileHandle[] = [];
  const mock = vi.mocked(NodeFSP.open);
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      mock.mockImplementation(async (...args) => {
        const handle = await actual.open(...args);
        handles.push(handle);
        await onOpen(handle, String(args[0]));
        return handle;
      }),
    ),
    () => Effect.sync(() => mock.mockImplementation(actual.open)),
  );
  return { actual, handles };
});

const expectClosed = (handles: readonly NodeFSP.FileHandle[]) => {
  expect(handles.length).toBeGreaterThan(0);
  expect(handles.every((handle) => handle.fd === -1)).toBe(true);
};

describe("Pi native configuration bounded reads and lifecycle", () => {
  it.effect(
    "reads exactly 256 KiB, rejects invalid UTF-8 and missing links, and closes each handle",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const c = yield* interceptOpens(async () => {});
        const target = f.path.join(f.agentDirectory, "auth.json");
        const text = encode({ [provider]: { type: "api_key", key: "SYNTHETIC-BOUNDED" } });
        yield* f.fs.writeFileString(target, text.padEnd(262144, " "));
        expect(Redacted.value(yield* readPiSavedLiteralCredential(f.agentDirectory))).toBe(
          "SYNTHETIC-BOUNDED",
        );
        expectClosed(c.handles);
        yield* f.fs.writeFileString(target, text.padEnd(262145, " "));
        yield* Effect.flip(readPiSavedLiteralCredential(f.agentDirectory));
        expectClosed(c.handles);
        yield* f.fs.writeFile(target, new Uint8Array([0xc3, 0x28]));
        yield* Effect.flip(readPiSavedLiteralCredential(f.agentDirectory));
        expectClosed(c.handles);
        yield* f.fs.remove(target);
        yield* f.fs.symlink(f.path.join(f.agentDirectory, "absent"), target);
        yield* Effect.flip(readPiSavedLiteralCredential(f.agentDirectory));
        expectClosed(c.handles);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects hard links, FIFO and symlink ancestors before any file read", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let reads = 0;
      const c = yield* interceptOpens(async (handle, path) => {
        if (!path.endsWith("/auth.json")) return;
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(async (...args) => {
          reads++;
          return read(...args);
        });
      });
      const target = f.path.join(f.agentDirectory, "auth.json");
      const source = f.path.join(f.agentDirectory, "source.json");
      yield* f.write("source.json", { [provider]: { type: "api_key", key: "SYNTHETIC-LINK" } });
      yield* Effect.promise(() => c.actual.link(source, target));
      yield* Effect.flip(readPiSavedLiteralCredential(f.agentDirectory));
      yield* f.fs.remove(target);
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            NodeChildProcess.execFile("/usr/bin/mkfifo", [target], (error) =>
              error ? reject(error) : resolve(),
            );
          }),
      );
      yield* Effect.flip(readPiSavedLiteralCredential(f.agentDirectory));
      yield* f.fs.remove(target);
      const nested = f.path.join(f.agentDirectory, "nested");
      yield* f.fs.makeDirectory(nested);
      yield* f.fs.writeFileString(
        f.path.join(nested, "auth.json"),
        encode({ [provider]: { type: "api_key", key: "SYNTHETIC-ANCESTOR" } }),
      );
      const link = f.path.join(f.agentDirectory, "ancestor-link");
      yield* f.fs.symlink(f.agentDirectory, link);
      yield* Effect.flip(readPiSavedLiteralCredential(f.path.join(link, "nested")));
      expect(reads).toBe(0);
      expectClosed(c.handles);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects an equal-size inode replacement before the first read", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const target = f.path.join(f.agentDirectory, "auth.json");
      const other = f.path.join(f.agentDirectory, "replacement.json");
      yield* f.write("auth.json", { [provider]: { type: "api_key", key: "SYNTHETIC-OWN" } });
      yield* f.write("replacement.json", { [provider]: { type: "api_key", key: "SYNTHETIC-NEW" } });
      const actual = yield* Effect.promise(() =>
        vi.importActual<typeof NodeFSP>("node:fs/promises"),
      );
      const handles: NodeFSP.FileHandle[] = [];
      let reads = 0;
      const mock = vi.mocked(NodeFSP.open);
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          mock.mockImplementation(async (...args) => {
            if (String(args[0]).endsWith("/auth.json")) await actual.rename(other, target);
            const handle = await actual.open(...args);
            handles.push(handle);
            const read = handle.read.bind(handle);
            vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
              reads++;
              return read(...readArgs);
            });
            return handle;
          }),
        ),
        () => Effect.sync(() => mock.mockImplementation(actual.open)),
      );
      yield* Effect.flip(readPiSavedLiteralCredential(f.agentDirectory));
      expect(reads).toBe(0);
      expectClosed(handles);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const change of ["grow", "overwrite", "unlink"] as const) {
    it.effect(`rejects ${change} during a real read and bounds the sentinel`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const target = f.path.join(f.agentDirectory, "auth.json");
        yield* f.write("auth.json", { [provider]: { type: "api_key", key: "SYNTHETIC-OLD" } });
        const actual = yield* Effect.promise(() =>
          vi.importActual<typeof NodeFSP>("node:fs/promises"),
        );
        let changed = false;
        let totalRead = 0;
        const c = yield* interceptOpens(async (handle, path) => {
          if (!path.endsWith("/auth.json")) return;
          const read = handle.read.bind(handle);
          vi.spyOn(handle, "read").mockImplementation(async (...args) => {
            if (!changed) {
              changed = true;
              if (change === "grow") await actual.writeFile(target, " ".repeat(262146));
              else if (change === "overwrite")
                await actual.writeFile(
                  target,
                  encode({ [provider]: { type: "api_key", key: "SYNTHETIC-NEW" } }),
                );
              else await actual.unlink(target);
            }
            const result = await read(...args);
            totalRead += result.bytesRead;
            return result;
          });
        });
        const error = yield* Effect.flip(readPiSavedLiteralCredential(f.agentDirectory));
        expect(changed).toBe(true);
        expect(totalRead).toBeLessThanOrEqual(262145);
        if (change === "grow") expect(totalRead).toBe(262145);
        expect(error.reason).toBe("credential-unavailable");
        expect(encode(error)).not.toContain("SYNTHETIC");
        expectClosed(c.handles);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("rejects unsupported platforms without opening native paths", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const c = yield* interceptOpens(async () => {});
      for (const platform of ["darwin", "win32"] as const) {
        yield* Effect.flip(
          inspectPiNativeConfiguration(f.input).pipe(
            Effect.provideService(HostProcessPlatform, platform),
          ),
        );
        yield* Effect.flip(
          readPiSavedLiteralCredential(f.agentDirectory).pipe(
            Effect.provideService(HostProcessPlatform, platform),
          ),
        );
      }
      expect(c.handles).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const pending of ["open", "read", "close"] as const) {
    it.effect(
      `joins a pending ${pending} and descriptor cleanup before cancellation completes`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.write("auth.json", { [provider]: { type: "api_key", key: "SYNTHETIC-CANCEL" } });
          const entered = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          let completed = false;
          let gated = false;
          const c = yield* interceptOpens(async (handle, path) => {
            if (!path.endsWith("/auth.json")) return;
            const gate = async () => {
              if (!gated) {
                gated = true;
                entered.resolve();
                await release.promise;
              }
            };
            if (pending === "open") await gate();
            if (pending === "read") {
              const read = handle.read.bind(handle);
              vi.spyOn(handle, "read").mockImplementation(async (...args) => {
                await gate();
                return read(...args);
              });
            }
            if (pending === "close") {
              const close = handle.close.bind(handle);
              vi.spyOn(handle, "close").mockImplementation(async () => {
                await gate();
                return close();
              });
            }
          });
          const worker = yield* readPiSavedLiteralCredential(f.agentDirectory).pipe(
            Effect.forkChild,
          );
          yield* Effect.promise(() => entered.promise);
          const interrupter = yield* Fiber.interrupt(worker).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                completed = true;
              }),
            ),
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          expect(completed).toBe(false);
          expect(c.handles.some((handle) => handle.fd !== -1)).toBe(true);
          release.resolve();
          yield* Fiber.join(interrupter);
          expect(completed).toBe(true);
          expectClosed(c.handles);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("closes all descriptors after an actual read failure and a rejected close", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("auth.json", { [provider]: { type: "api_key", key: "SYNTHETIC-FAILURE" } });
      for (const failure of ["read", "close"] as const) {
        let attempts = 0;
        const c = yield* interceptOpens(async (handle, path) => {
          if (!path.endsWith("/auth.json")) return;
          if (failure === "read")
            vi.spyOn(handle, "read").mockRejectedValue(new Error("SYNTHETIC-FAILURE"));
          else {
            const close = handle.close.bind(handle);
            vi.spyOn(handle, "close").mockImplementation(async () => {
              attempts++;
              if (attempts === 1) throw new Error("SYNTHETIC-FAILURE");
              return close();
            });
          }
        });
        const error = yield* Effect.flip(readPiSavedLiteralCredential(f.agentDirectory));
        expect(encode(error)).not.toContain("SYNTHETIC-FAILURE");
        expectClosed(c.handles);
        if (failure === "close") expect(attempts).toBe(2);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
