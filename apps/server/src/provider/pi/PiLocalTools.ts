import type { AgentToolResult, BashOperations } from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";
import { makePiBashToolIsolation } from "./PiBashToolIsolation.ts";
import { makePiSelectedSkillRead } from "./PiSelectedSkillRead.ts";
import type { PiWorkerBootstrap } from "./PiWorkerProtocol.ts";
import { PI_WORKER_MAX_TOOL_BYTES, PiWorkerToolOutput } from "./PiWorkerProtocol.ts";

const MAX_PATH = 4096;
const MAX_TEXT = 60_000;
const MAX_COMMAND = 12_288;
const MAX_EDITS = 64;
const MAX_TIMEOUT_SECONDS = 2_147_483.647;
const text = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));
const path = text(MAX_PATH).check(Schema.isMinLength(1), Schema.isPattern(/^[^\0]+$/));
const positiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const ReadInput = Schema.Struct({
  path,
  offset: Schema.optionalKey(positiveInteger),
  limit: Schema.optionalKey(positiveInteger),
});
const WriteInput = Schema.Struct({ path, content: text(MAX_TEXT) });
const EditInput = Schema.Struct({
  path,
  edits: Schema.Array(Schema.Struct({ oldText: text(MAX_TEXT), newText: text(MAX_TEXT) })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_EDITS),
  ),
});
const BashInput = Schema.Struct({
  command: text(MAX_COMMAND).check(Schema.isMinLength(1), Schema.isPattern(/^[^\0]+$/)),
  timeout: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_TIMEOUT_SECONDS)),
  ),
});
const Cwd = path.check(
  Schema.isPattern(/^\/(?:[^/]+(?:\/[^/]+)*)?$/),
  Schema.makeFilter((value) => !value.split("/").some((part) => part === "." || part === "..")),
);
const decodeCwd = Schema.decodeSync(Cwd);
const parseObject = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject));
const parseOutput = Schema.decodeUnknownSync(Schema.fromJsonString(PiWorkerToolOutput));

class MissingReadLeafError extends Error {}

function boundedJson(value: unknown, maximum: number) {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > maximum) throw Error("TOOL_FAILURE");
  return json;
}

function parameters(schema: Schema.Top) {
  const document = Schema.toJsonSchemaDocument(Schema.toType(schema));
  return parseObject(
    boundedJson(
      {
        ...document.schema,
        ...(document.definitions ? { $defs: document.definitions } : {}),
        additionalProperties: false,
      },
      PI_WORKER_MAX_TOOL_BYTES,
    ),
  );
}

/** Parent advertisement is inert. Selecting capabilities and authorizing calls remain Root-owned. */
export const piLocalToolDefinitions = Object.freeze([
  Object.freeze({
    capabilityId: "pi.read",
    name: "read",
    description:
      "Read text files with native offset/limit paging and truncation. Image attachments are unavailable in this managed profile.",
    parameters: parameters(ReadInput),
  }),
  Object.freeze({
    capabilityId: "pi.write",
    name: "write",
    description: "Create or overwrite a text file, creating missing parent directories.",
    parameters: parameters(WriteInput),
  }),
  Object.freeze({
    capabilityId: "pi.edit",
    name: "edit",
    description:
      "Edit one file with unique, non-overlapping exact replacements matched against its original contents.",
    parameters: parameters(EditInput),
  }),
  Object.freeze({
    capabilityId: "pi.bash",
    name: "bash",
    description:
      "Execute a bash command in the explicit workspace and return stdout/stderr. Nonzero exits fail the tool call. Optional timeout is in seconds.",
    parameters: parameters(BashInput),
  }),
]);

function output(result: AgentToolResult<unknown>) {
  // Local SDK error flags are reserved for the separately classified missing-leaf
  // result; reject other flags and image attachments rather than losing their meaning.
  if (result.isError || result.content.some((part) => part.type !== "text"))
    throw Error("TOOL_FAILURE");
  return parseOutput(
    boundedJson(
      {
        kind: "json",
        value: {
          content: result.content,
          ...(result.details !== undefined ? { details: result.details } : {}),
          ...(result.structuredContent !== undefined
            ? { structuredContent: result.structuredContent }
            : {}),
        },
      },
      PI_WORKER_MAX_TOOL_BYTES,
    ),
  );
}

function adapt<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  execute: (args: S["Type"], signal: AbortSignal) => Promise<AgentToolResult<unknown>>,
  assertOpen: () => void = () => {},
) {
  const decode = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });
  return async (args: Schema.JsonObject, signal: AbortSignal) => {
    let input: S["Type"];
    try {
      boundedJson(args, PI_WORKER_MAX_TOOL_BYTES);
      input = decode(args);
    } catch {
      throw Error("INVALID_INPUT");
    }
    if (signal.aborted) throw Error("CANCELED");
    try {
      assertOpen();
      const result = await execute(input, signal);
      if (signal.aborted) throw Error("CANCELED");
      return output(result);
    } catch (error) {
      if (signal.aborted) throw Error("CANCELED");
      if (error instanceof MissingReadLeafError)
        return parseOutput(
          boundedJson({ kind: "error", code: "FILE_NOT_FOUND" }, PI_WORKER_MAX_TOOL_BYTES),
        );
      if (error instanceof Error && error.message === "UNAVAILABLE") throw Error("UNAVAILABLE");
      throw Error("TOOL_FAILURE");
    }
  };
}

/** The Linux worker admits one workspace mount, never ambient filesystem authority. */
async function workspaceFiles(cwd: string) {
  if (process.getBuiltinModule("os").platform() !== "linux") throw Error("UNAVAILABLE");
  const fs = process.getBuiltinModule("fs");
  const paths = process.getBuiltinModule("path");
  const files = fs.promises;
  const admitRoot = async () => {
    const root = await files.lstat(cwd, { bigint: true });
    if (!root.isDirectory() || (await files.realpath(cwd)) !== cwd) throw Error("TOOL_FAILURE");
    return root;
  };
  let admission: ReturnType<typeof admitRoot> | undefined;
  const same = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) =>
    a.dev === b.dev && a.ino === b.ino;
  const fdPath = (fd: number) => `/proc/self/fd/${fd}`;
  const checkedPath = (input: string) => {
    // The pinned SDK expands these spellings before its ambient read-path existence
    // probe. Admit that result before entering the SDK; every operation also checks it.
    let normalized = input
      .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
      .replace(/^@/, "");
    if (normalized === "~" || normalized.startsWith("~/"))
      normalized = paths.join(process.getBuiltinModule("os").homedir(), normalized.slice(2));
    if (normalized.startsWith("file://"))
      normalized = process.getBuiltinModule("url").fileURLToPath(normalized);
    const absolute = paths.resolve(cwd, normalized);
    const relative = paths.relative(cwd, absolute);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith("../") ||
      paths.isAbsolute(relative) ||
      relative.split("/").includes(".git")
    )
      throw Error("TOOL_FAILURE");
    return absolute;
  };
  return async (
    input: string,
    kind: "read" | "write" | "edit",
    signal: AbortSignal,
    run: (
      operations: {
        readFile: (path: string) => Promise<Buffer>;
        access: (path: string) => Promise<void>;
        mkdir: (path: string) => Promise<void>;
        writeFile: (path: string, content: string) => Promise<void>;
        detectImageMimeType: (
          path: string,
          detect: (descriptor: string) => Promise<string | null | undefined>,
        ) => Promise<string | null | undefined>;
      },
      readPath: string | undefined,
    ) => Promise<AgentToolResult<unknown>>,
  ) => {
    const absolute = checkedPath(input);
    const components = paths.relative(cwd, absolute).split("/");
    type Handle = Awaited<ReturnType<typeof files.open>>;
    const handles: Handle[] = [];
    const pending = new Set<Promise<unknown>>();
    const checkSignal = () => {
      if (signal.aborted) throw Error("CANCELED");
    };
    const missing = (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "ENOENT";
    const load = async () => {
      checkSignal();
      const root = await (admission ??= admitRoot());
      const directoryFlags =
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
      let parent = await files.open(cwd, directoryFlags);
      handles.push(parent);
      if (!same(await parent.stat({ bigint: true }), root)) throw Error("TOOL_FAILURE");
      for (const component of components.slice(0, -1)) {
        checkSignal();
        const path = `${fdPath(parent.fd)}/${component}`;
        if (kind === "write")
          await files.mkdir(path).catch((error: unknown) => {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
              throw error;
          });
        parent = await files.open(path, directoryFlags);
        handles.push(parent);
      }
      const target = `${fdPath(parent.fd)}/${components.at(-1)!}`;
      let file: Handle | undefined;
      let missingReadLeaf = false;
      try {
        file = await files.open(
          target,
          (kind === "read"
            ? fs.constants.O_RDONLY
            : kind === "edit"
              ? fs.constants.O_RDWR
              : fs.constants.O_WRONLY) |
            fs.constants.O_NOFOLLOW |
            fs.constants.O_NONBLOCK,
        );
        handles.push(file);
      } catch (error) {
        if (kind === "read" && missing(error)) missingReadLeaf = true;
        else if (kind !== "write" || !missing(error)) throw error;
      }
      const identity = file ? await file.stat({ bigint: true }) : undefined;
      if (identity && (!identity.isFile() || identity.nlink !== 1n)) throw Error("TOOL_FAILURE");
      const verify = async () => {
        checkSignal();
        if (
          !same(await handles[0]!.stat({ bigint: true }), root) ||
          (await files.realpath(fdPath(handles[0]!.fd))) !== cwd ||
          (await files.realpath(fdPath(parent.fd))) !== paths.dirname(absolute)
        )
          throw Error("TOOL_FAILURE");
        const current = await files.lstat(target, { bigint: true }).catch((error: unknown) => {
          if (missing(error)) return undefined;
          throw error;
        });
        if (
          identity
            ? !current || !current.isFile() || current.nlink !== 1n || !same(current, identity)
            : current !== undefined
        )
          throw Error("TOOL_FAILURE");
        if (
          file &&
          ((await file.stat({ bigint: true })).nlink !== 1n ||
            (await files.realpath(fdPath(file.fd))) !== absolute)
        )
          throw Error("TOOL_FAILURE");
      };
      await verify();
      if (missingReadLeaf) throw new MissingReadLeafError();
      return { parent, target, file, identity, verify };
    };
    // Bind after the SDK's mutation queue is acquired, so successive writes to the
    // same path retain its native ordering. All hooks share this call's descriptors.
    let binding: ReturnType<typeof load> | undefined;
    const bound = () => (binding ??= load());
    const operate = <A>(body: () => Promise<A>) => {
      const promise = body();
      pending.add(promise);
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      );
      return promise;
    };
    let sdkPath = absolute;
    const assertPath = (path: string) => {
      if (path !== sdkPath) throw Error("TOOL_FAILURE");
    };
    try {
      // Read's pinned SDK resolver performs its own existence probes. Give it the
      // admitted descriptor so even those probes cannot follow an ambient alias.
      if (kind === "read") {
        const file = await bound();
        if (!file.file) throw Error("TOOL_FAILURE");
        sdkPath = fdPath(file.file.fd);
      }
      return await run(
        {
          access: (path) =>
            operate(async () => {
              assertPath(path);
              await (await bound()).verify();
            }),
          mkdir: (path) =>
            operate(async () => {
              if (path !== paths.dirname(absolute)) throw Error("TOOL_FAILURE");
              await (await bound()).verify();
            }),
          readFile: (path) =>
            operate(async () => {
              assertPath(path);
              const file = await bound();
              await file.verify();
              if (!file.file) throw Error("TOOL_FAILURE");
              const bytes = await file.file.readFile({ signal });
              await file.verify();
              return bytes;
            }),
          detectImageMimeType: (path, detect) =>
            operate(async () => {
              assertPath(path);
              const file = await bound();
              await file.verify();
              if (!file.file) throw Error("TOOL_FAILURE");
              const mime = await detect(fdPath(file.file.fd));
              await file.verify();
              return mime;
            }),
          writeFile: (path, content) =>
            operate(async () => {
              assertPath(path);
              const file = await bound();
              await file.verify();
              // Replace the directory entry instead of truncating the old inode. A hard
              // link created after validation can never redirect this write outside cwd.
              const temporary = `${fdPath(file.parent.fd)}/.t3-pi-${process.getBuiltinModule("crypto").randomUUID()}`;
              const output = await files.open(
                temporary,
                fs.constants.O_WRONLY |
                  fs.constants.O_CREAT |
                  fs.constants.O_EXCL |
                  fs.constants.O_NOFOLLOW,
                file.identity ? Number(file.identity.mode & 0o777n) : 0o666,
              );
              try {
                await output.writeFile(content, { encoding: "utf8", signal });
                if (file.identity) await output.chmod(Number(file.identity.mode & 0o777n));
                await file.verify();
                await files.rename(temporary, file.target);
              } finally {
                await output.close();
                await files.unlink(temporary).catch((error: unknown) => {
                  if (!missing(error)) throw error;
                });
              }
            }),
        },
        kind === "read" ? sdkPath : undefined,
      );
    } finally {
      // SDK read cancellation rejects promptly; drain any admitted descriptor work
      // before closing it, even when its native promise has already rejected.
      await Promise.allSettled(pending);
      if (binding) await binding.catch(() => undefined);
      for (const handle of handles.toReversed()) await handle.close();
    }
  };
}

async function loadSdk() {
  if (!process.env.PI_PACKAGE_DIR) throw Error("UNAVAILABLE");
  const sdk = await import("@earendil-works/pi-coding-agent");
  if (sdk.VERSION !== "0.99.1") throw Error("UNAVAILABLE");
  return sdk;
}

async function makeLocalTools(
  cwd: string,
  sdk: Awaited<ReturnType<typeof loadSdk>>,
  operations: BashOperations,
  selectedRead?: Awaited<ReturnType<typeof makePiSelectedSkillRead>>["read"],
  assertOpen: () => void = () => {},
) {
  const executeFile = await workspaceFiles(cwd);
  const bash = sdk.createBashTool(cwd, { operations, exposeSessionEnvironment: false });
  return Object.freeze({
    tools: piLocalToolDefinitions,
    localTools: Object.freeze({
      read: adapt(
        ReadInput,
        (args, signal) => {
          // Route only the original canonical absolute spelling. SDK aliases never
          // expand into selected-resource authority.
          if (
            selectedRead &&
            args.path.startsWith("/runtime/skills/") &&
            /^\/(?:[^/\\\0\r\n]+\/)*[^/\\\0\r\n]+$/.test(args.path) &&
            !args.path.split("/").some((part) => part === "." || part === "..")
          )
            return selectedRead(args, signal);
          return executeFile(args.path, "read", signal, (operations, readPath) =>
            sdk
              .createReadTool(cwd, {
                autoResizeImages: false,
                operations: {
                  ...operations,
                  detectImageMimeType: (path) =>
                    operations.detectImageMimeType(path, sdk.detectSupportedImageMimeTypeFromFile),
                },
              })
              .execute("t3-local-read", { ...args, path: readPath! }, signal),
          );
        },
        assertOpen,
      ),
      write: adapt(
        WriteInput,
        (args, signal) =>
          executeFile(args.path, "write", signal, (operations) =>
            sdk.createWriteTool(cwd, { operations }).execute("t3-local-write", args, signal),
          ),
        assertOpen,
      ),
      edit: adapt(
        EditInput,
        (args, signal) =>
          executeFile(args.path, "edit", signal, (operations) =>
            sdk
              .createEditTool(cwd, { operations })
              .execute("t3-local-edit", { ...args, edits: [...args.edits] }, signal),
          ),
        assertOpen,
      ),
      bash: adapt(
        BashInput,
        (args, signal) => bash.execute("t3-local-bash", args, signal),
        assertOpen,
      ),
    }),
  });
}

/** File-only fixture constructor. Bash requires the owned production factory. */
export async function makePiLocalTools(cwd: string) {
  try {
    decodeCwd(cwd);
  } catch {
    throw Error("INVALID_INPUT");
  }
  return makeLocalTools(cwd, await loadSdk(), {
    exec: () => Promise.reject(Error("UNAVAILABLE")),
  });
}

/** Read the fixed outer mount's mode; the owned helper independently admits its authority. */
async function workspaceAccess() {
  const fs = process.getBuiltinModule("fs");
  const handle = await fs.promises.open(
    "/proc/self/mountinfo",
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const bytes = Buffer.alloc(65_537);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > 65_536) throw Error("UNAVAILABLE");
    const rows = bytes.toString("utf8", 0, length).trimEnd().split("\n");
    if (rows.length > 512) throw Error("UNAVAILABLE");
    const mounts = rows.map((row) => {
      const pieces = row.split(" - ");
      const fields = pieces[0]?.split(" ") ?? [];
      if (
        pieces.length !== 2 ||
        fields.length < 6 ||
        fields.length > 32 ||
        !/^[1-9][0-9]{0,19}$/.test(fields[0] ?? "") ||
        !/^[1-9][0-9]{0,19}$/.test(fields[1] ?? "") ||
        !/^[0-9]+:[0-9]+$/.test(fields[2] ?? "") ||
        !fields[4]?.startsWith("/") ||
        pieces[1]?.split(" ").length !== 3
      )
        throw Error("UNAVAILABLE");
      return { id: fields[0]!, path: fields[4]!, options: fields[5]!.split(",") };
    });
    if (new Set(mounts.map((mount) => mount.id)).size !== mounts.length) throw Error("UNAVAILABLE");
    const assigned = mounts.filter((mount) => mount.path === "/workspace");
    if (assigned.length !== 1) throw Error("UNAVAILABLE");
    const options = assigned[0]!.options;
    if (
      new Set(options).size !== options.length ||
      options.some((option) => !option || /\s/.test(option)) ||
      options.filter((option) => option === "ro" || option === "rw").length !== 1
    )
      throw Error("UNAVAILABLE");
    return options.includes("ro") ? "readonly" : "readwrite";
  } finally {
    await handle.close();
  }
}

/**
 * Fixed child factory inside Root's authorized cage. PI_PACKAGE_DIR is set before import.
 * The outer role mount supplies its access mode; recursive bind retains readonly flags.
 * Root fences that mount for the run and joins the native owner after this SDK close.
 */
export async function makePiIsolatedLocalTools() {
  const sdk = await loadSdk();
  const owner = await makePiBashToolIsolation({
    localOperations: sdk.createLocalBashOperations({ shellPath: "/bin/bash" }),
    workspaceAccess: await workspaceAccess(),
    protectedWorkspacePaths: ["/workspace/.git"],
  });
  let closed = false;
  let activated = false;
  let selected: Awaited<ReturnType<typeof makePiSelectedSkillRead>> | undefined;
  let initialization: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const assertOpen = () => {
    if (closed) throw Error("UNAVAILABLE");
  };
  // The authenticated bootstrap supplies selection, never paths or backend grants
  // from tool callers. Revocation joins acquisition before releasing its handles.
  const initializeLocalResources = (resources: NonNullable<PiWorkerBootstrap["resources"]>) => {
    if (closed || activated) return Promise.reject(Error("UNAVAILABLE"));
    activated = true;
    initialization = (async () => {
      selected = await makePiSelectedSkillRead(resources.skills);
    })();
    return initialization.then(assertOpen);
  };
  const close = () => {
    closed = true;
    return (closing ??= (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => owner.close()),
        (async () => {
          let failed = false;
          if (initialization)
            await initialization.catch(() => {
              failed = true;
            });
          await selected?.close();
          if (failed) throw Error("TOOL_FAILURE");
        })(),
      ]);
      if (results.some((result) => result.status === "rejected")) throw Error("TOOL_FAILURE");
    })());
  };
  try {
    return Object.freeze({
      ...(await makeLocalTools(
        "/workspace",
        sdk,
        owner.operations,
        (args, signal) => {
          if (!selected) return Promise.reject(Error("UNAVAILABLE"));
          return selected.read(args, signal);
        },
        assertOpen,
      )),
      initializeLocalResources,
      close,
    });
  } catch (error) {
    await close();
    throw error;
  }
}
