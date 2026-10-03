// @effect-diagnostics nodeBuiltinImport:off - Linux descriptor-relative opens and nanosecond stats are needed for contained, nonmutating reads.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const provider = "command-code";
const model = "inclusionai/ling-3.1-flash:free";
const baseUrl = "https://api.commandcode.ai/provider/v1";
const endpoint = `${baseUrl}/chat/completions`;
const catalogueSource = `${baseUrl}/models`;
const maxFileBytes = 262144;
const strict = { onExcessProperty: "error" } as const;
const PositiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const Directory = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.makeFilter((value) => value.trim() === value && !/\p{Cc}/u.test(value)),
);
const FetchedAt = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
);
const Catalogue = Schema.Struct({
  source: Schema.Literal(catalogueSource),
  fetchedAt: FetchedAt,
  selectedEntry: Schema.Struct({
    id: Schema.Literal(model),
    owned_by: Schema.Literal(provider),
    context_length: PositiveInteger,
    supported_endpoints: Schema.Array(Schema.String).check(
      Schema.isMaxLength(32),
      Schema.makeFilter((endpoints) => endpoints.includes("/chat/completions")),
    ),
    max_output_tokens: Schema.optional(PositiveInteger),
  }).annotate({ parseOptions: { onExcessProperty: "ignore" } }),
});
const Limits = Schema.Struct({
  maxInputTokens: PositiveInteger.check(Schema.isLessThanOrEqualTo(1000000)),
  maxOutputTokens: PositiveInteger.check(Schema.isLessThanOrEqualTo(65536)),
  deadlineMs: PositiveInteger.check(Schema.isLessThanOrEqualTo(300000)),
});
const Input = Schema.Struct({
  agentDirectory: Directory,
  selectedModel: Schema.Struct({
    provider: Schema.Literal(provider),
    model: Schema.Literal(model),
  }),
  catalogue: Catalogue,
  limits: Limits,
  nodeVersion: Schema.String.check(
    Schema.isMaxLength(32),
    Schema.isPattern(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/),
    Schema.makeFilter((value) => {
      const parts = value.split(".").map(Number);
      const [major, minor] = parts;
      return (
        parts.every(Number.isSafeInteger) &&
        major !== undefined &&
        minor !== undefined &&
        (major > 22 || (major === 22 && minor >= 19))
      );
    }),
  ),
});
const NativeModels = Schema.Struct({
  providers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const NativeProvider = Schema.Struct({
  baseUrl: Schema.optional(Schema.Literal(baseUrl)),
  api: Schema.optional(Schema.Literal("openai-completions")),
  models: Schema.optional(
    Schema.Array(Schema.Record(Schema.String, Schema.Unknown)).check(Schema.isMaxLength(256)),
  ),
});
const NativeModel = Schema.Struct({
  id: Schema.Literal(model),
  baseUrl: Schema.optional(Schema.Literal(baseUrl)),
  api: Schema.optional(Schema.Literal("openai-completions")),
  contextWindow: Schema.optional(PositiveInteger),
  maxTokens: Schema.optional(PositiveInteger),
  reasoning: Schema.optional(Schema.Literal(false)),
  input: Schema.optional(Schema.Tuple([Schema.Literal("text")])),
});
const SavedCredential = Schema.Struct({
  type: Schema.Literal("api_key"),
  key: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4096),
    Schema.makeFilter((value) => !/[^\x21-\x7e]|\$/.test(value) && !value.startsWith("!")),
  ),
});
const decodeDirectory = Schema.decodeUnknownEffect(Directory);
const decodeInput = Schema.decodeUnknownEffect(Input, strict);
const decodeFetchedAt = Schema.decodeEffect(Schema.DateTimeUtcFromString);
const decodeNativeModels = Schema.decodeEffect(fromLenientJson(NativeModels));
const decodeNativeProvider = Schema.decodeUnknownEffect(NativeProvider, strict);
const decodeNativeModel = Schema.decodeUnknownEffect(NativeModel, strict);
const decodeAuth = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeCredential = Schema.decodeUnknownEffect(SavedCredential, strict);

export class PiNativeConfigurationUnavailable extends Schema.TaggedError<PiNativeConfigurationUnavailable>()(
  "PiNativeConfigurationUnavailable",
  {
    reason: Schema.Literals(["configuration", "native-configuration", "credential-unavailable"]),
  },
) {}

type UnavailableReason = PiNativeConfigurationUnavailable["reason"];
const unavailable = (reason: UnavailableReason) => new PiNativeConfigurationUnavailable({ reason });

const canonicalDirectory = Effect.fn("PiNativeConfiguration.canonicalDirectory")(function* (
  input: unknown,
  reason: UnavailableReason,
) {
  const platform = yield* HostProcessPlatform;
  if (platform !== "linux") return yield* unavailable(reason);
  const directory = yield* decodeDirectory(input).pipe(Effect.mapError(() => unavailable(reason)));
  if (!NodePath.isAbsolute(directory) || NodePath.normalize(directory) !== directory) {
    return yield* unavailable(reason);
  }
  return directory;
});

const sameIdentity = (left: NodeFS.BigIntStats, right: NodeFS.BigIntStats) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.nlink === right.nlink;
const sameStat = (left: NodeFS.BigIntStats, right: NodeFS.BigIntStats) =>
  sameIdentity(left, right) &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

// The promise owns every descriptor through joined cleanup. Interruption waits for
// pending opens/reads/closes instead of abandoning work that can still acquire an FD.
const readBoundedFile = Effect.fn("PiNativeConfiguration.readBoundedFile")(function* (
  directory: string,
  name: "models.json" | "auth.json",
  reason: UnavailableReason,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const handles: NodeFSP.FileHandle[] = [];
      const fail = () => {
        throw unavailable(reason);
      };
      const directoryFlags =
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW;
      const fdPath = (handle: NodeFSP.FileHandle) => `/proc/self/fd/${handle.fd}`;
      try {
        // Pin every ancestor before descending: final-component O_NOFOLLOW alone
        // cannot prevent a substituted parent from redirecting the open.
        const rootBefore = await NodeFSP.lstat("/", { bigint: true });
        let parent = await NodeFSP.open("/", directoryFlags);
        handles.push(parent);
        if (
          !sameIdentity(rootBefore, await parent.stat({ bigint: true })) ||
          (await NodeFSP.realpath(fdPath(parent))) !== "/"
        )
          fail();
        let expectedDirectory = "/";
        for (const component of directory.split("/").filter(Boolean)) {
          const childPath = `${fdPath(parent)}/${component}`;
          const before = await NodeFSP.lstat(childPath, { bigint: true });
          if (!before.isDirectory() || before.nlink < 1n) fail();
          const child = await NodeFSP.open(childPath, directoryFlags);
          handles.push(child);
          expectedDirectory = NodePath.join(expectedDirectory, component);
          if (
            !sameIdentity(before, await child.stat({ bigint: true })) ||
            (await NodeFSP.realpath(fdPath(child))) !== expectedDirectory ||
            (await NodeFSP.realpath(fdPath(parent))) !== NodePath.dirname(expectedDirectory)
          )
            fail();
          await parent.close();
          parent = child;
        }
        const rootPath = fdPath(parent);
        const rootStat = await parent.stat({ bigint: true });
        if (
          !rootStat.isDirectory() ||
          rootStat.nlink < 1n ||
          (await NodeFSP.realpath(rootPath)) !== directory
        )
          fail();
        const target = `${rootPath}/${name}`;
        const expectedFile = NodePath.join(directory, name);
        let before: NodeFS.BigIntStats;
        try {
          before = await NodeFSP.lstat(target, { bigint: true });
        } catch (error) {
          if (
            name === "models.json" &&
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            if (
              !sameStat(rootStat, await parent.stat({ bigint: true })) ||
              (await NodeFSP.realpath(rootPath)) !== directory
            )
              fail();
            return undefined;
          }
          throw error;
        }
        if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxFileBytes)) fail();
        // NONBLOCK prevents a file-to-FIFO race from blocking before fstat rejects it.
        const file = await NodeFSP.open(
          target,
          NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
        );
        handles.push(file);
        const opened = await file.stat({ bigint: true });
        const verify = async () => {
          if (
            !sameStat(before, await file.stat({ bigint: true })) ||
            !sameStat(before, await NodeFSP.lstat(target, { bigint: true })) ||
            !sameStat(rootStat, await parent.stat({ bigint: true })) ||
            (await NodeFSP.realpath(fdPath(file))) !== expectedFile ||
            (await NodeFSP.realpath(rootPath)) !== directory
          )
            fail();
        };
        if (!opened.isFile() || !sameStat(before, opened)) fail();
        await verify(); // No native bytes are read before descriptor identity and containment agree.
        const buffer = new Uint8Array(maxFileBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length > maxFileBytes || BigInt(length) !== opened.size) fail();
        await verify();
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      } finally {
        let closeFailed = false;
        for (const handle of handles.toReversed()) {
          try {
            await handle.close();
          } catch {
            closeFailed = true;
            // A rejected close must not skip other handles; retry this owned
            // FileHandle once without ever closing a possibly reused raw fd.
            try {
              await handle.close();
            } catch {
              /* Fail unavailable after all joins. */
            }
          }
        }
        if (closeFailed) fail();
      }
    },
    catch: () => unavailable(reason),
  }).pipe(Effect.uninterruptible);
});

/** Root supplies the current selected catalogue and SQL-frozen route; this grants no authority. */
export const inspectPiNativeConfiguration = Effect.fn("inspectPiNativeConfiguration")(function* (
  input: unknown,
) {
  // Catalogue entries can grow optional public metadata; none of those extras grant capabilities.
  const value = yield* decodeInput(input).pipe(Effect.mapError(() => unavailable("configuration")));
  const fetchedAt = yield* decodeFetchedAt(value.catalogue.fetchedAt).pipe(
    Effect.mapError(() => unavailable("configuration")),
  );
  if (DateTime.formatIso(fetchedAt) !== value.catalogue.fetchedAt)
    return yield* unavailable("configuration");
  const advertised = value.catalogue.selectedEntry;
  if (
    value.limits.maxInputTokens + value.limits.maxOutputTokens > advertised.context_length ||
    (advertised.max_output_tokens !== undefined &&
      value.limits.maxOutputTokens > advertised.max_output_tokens)
  ) {
    return yield* unavailable("configuration");
  }
  const directory = yield* canonicalDirectory(value.agentDirectory, "native-configuration");
  const contents = yield* readBoundedFile(directory, "models.json", "native-configuration");
  if (contents !== undefined) {
    const native = yield* decodeNativeModels(contents).pipe(
      Effect.mapError(() => unavailable("native-configuration")),
    );
    const selectedProvider = native.providers?.[provider];
    if (selectedProvider !== undefined) {
      const configured = yield* decodeNativeProvider(selectedProvider).pipe(
        Effect.mapError(() => unavailable("native-configuration")),
      );
      const selected = configured.models?.filter((entry) => entry.id === model) ?? [];
      if (selected.length > 1) return yield* unavailable("native-configuration");
      if (selected[0] !== undefined) {
        const configuredModel = yield* decodeNativeModel(selected[0]).pipe(
          Effect.mapError(() => unavailable("native-configuration")),
        );
        if (
          (configuredModel.contextWindow !== undefined &&
            configuredModel.contextWindow !== advertised.context_length) ||
          (configuredModel.maxTokens !== undefined &&
            configuredModel.maxTokens !== value.limits.maxOutputTokens)
        ) {
          return yield* unavailable("native-configuration");
        }
      }
    }
  }
  // Freshness (including the root's 24-hour policy) and current SQL authorization remain caller obligations.
  return Object.freeze({
    provider,
    model,
    api: "openai-completions" as const,
    endpoint,
    contextWindow: advertised.context_length,
    maxInputTokens: value.limits.maxInputTokens,
    maxOutputTokens: value.limits.maxOutputTokens,
    advertisedMaxOutputTokens: advertised.max_output_tokens ?? null,
    deadlineMs: value.limits.deadlineMs,
    reasoning: false as const,
    input: Object.freeze(["text"] as const),
    cost: "unknown" as const,
    catalogue: Object.freeze({ source: catalogueSource, fetchedAt: value.catalogue.fetchedAt }),
  });
});

/** Invoke only from the parent broker after its current-authority check; never during inspection. */
export const readPiSavedLiteralCredential = Effect.fn("readPiSavedLiteralCredential")(function* (
  agentDirectory: unknown,
) {
  const directory = yield* canonicalDirectory(agentDirectory, "credential-unavailable");
  const contents = yield* readBoundedFile(directory, "auth.json", "credential-unavailable");
  if (contents === undefined) return yield* unavailable("credential-unavailable");
  const auth = yield* decodeAuth(contents).pipe(
    Effect.mapError(() => unavailable("credential-unavailable")),
  );
  const credential = yield* decodeCredential(auth[provider]).pipe(
    Effect.mapError(() => unavailable("credential-unavailable")),
  );
  return Redacted.make(credential.key);
});
