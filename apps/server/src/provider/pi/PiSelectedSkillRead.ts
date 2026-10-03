import type { AgentToolResult, ReadToolInput } from "@earendil-works/pi-coding-agent";
import { ManagedSkillKey } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { PiWorkerBootstrap } from "./PiWorkerProtocol.ts";

const fs = process.getBuiltinModule("fs");
const files = fs.promises;
const paths = process.getBuiltinModule("path").posix;
const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const readFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const maxPackageBytes = 8_000_000;
const maxManifestBytes = 65_536;
const maxProcBytes = 65_536;
type Handle = Awaited<ReturnType<typeof files.open>>;
type NativeStat = Awaited<ReturnType<typeof stat>>;
const stat = (path: string) => files.lstat(path, { bigint: true });
const fdPath = (handle: Handle) => `/proc/self/fd/${handle.fd}`;
const failure = () => Error("TOOL_FAILURE");
const checkSignal = (signal: AbortSignal) => {
  if (signal.aborted) throw Error("Operation aborted");
};
const sameIdentity = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) =>
  a.dev === b.dev && a.ino === b.ino;
const sameFile = (a: NativeStat, b: NativeStat) =>
  sameIdentity(a, b) &&
  a.mode === b.mode &&
  a.uid === b.uid &&
  a.gid === b.gid &&
  a.nlink === b.nlink &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;
const boundedText = (maximum: number) =>
  Schema.String.check(
    Schema.makeFilter(
      (value) =>
        Buffer.byteLength(value, "utf8") <= maximum &&
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),
    ),
  );
const canonicalPath = boundedText(4096).check(
  Schema.isPattern(/^\/(?:[^/\\\0\r\n]+(?:\/[^/\\\0\r\n]+)*)$/),
  Schema.makeFilter(
    (value) =>
      !value
        .split("/")
        .some(
          (part) =>
            part === "." ||
            part === ".." ||
            part.startsWith("@") ||
            part.startsWith("~") ||
            part.startsWith("file:"),
        ),
  ),
);
const Selection = Schema.Array(
  Schema.Struct({
    key: ManagedSkillKey,
    path: canonicalPath,
    description: boundedText(4000),
  }),
).check(
  Schema.isMaxLength(32),
  Schema.makeFilter(
    (value) =>
      new Set(value.map((entry) => entry.key)).size === value.length &&
      value.every((entry) => entry.path === `/runtime/skills/${entry.key}/SKILL.md`),
  ),
);
const positiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const ReadInput = Schema.Struct({
  path: canonicalPath,
  offset: Schema.optionalKey(positiveInteger),
  limit: Schema.optionalKey(positiveInteger),
});
const decodeSelection = Schema.decodeUnknownSync(Selection, { onExcessProperty: "error" });
const decodeRead = Schema.decodeUnknownSync(ReadInput, { onExcessProperty: "error" });
const decodeMetadata = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.Literal("@earendil-works/pi-coding-agent"),
      version: Schema.Literal("0.99.1"),
    }),
  ),
);

async function closeHandles(handles: ReadonlyArray<Handle>) {
  const outcomes = await Promise.allSettled(handles.toReversed().map((handle) => handle.close()));
  if (outcomes.some((outcome) => outcome.status === "rejected")) throw failure();
}

async function boundedBytes(
  handle: Handle,
  maximum: number,
  signal?: AbortSignal,
  expected?: number,
) {
  const bytes = Buffer.alloc((expected ?? maximum) + 1);
  let offset = 0;
  while (offset < bytes.length) {
    if (signal) checkSignal(signal);
    const next = await handle.read(bytes, offset, Math.min(65_536, bytes.length - offset), offset);
    if (next.bytesRead === 0) break;
    offset += next.bytesRead;
  }
  if (signal) checkSignal(signal);
  if (offset > maximum || (expected !== undefined && offset !== expected)) throw failure();
  return bytes.subarray(0, offset);
}

async function readProc(path: string) {
  const handle = await files.open(path, readFlags);
  try {
    return (await boundedBytes(handle, maxProcBytes)).toString("utf8");
  } finally {
    await handle.close();
  }
}

interface Mount {
  readonly id: string;
  readonly point: string;
  readonly readonly: boolean;
}
async function mounts(): Promise<ReadonlyArray<Mount>> {
  const text = await readProc("/proc/self/mountinfo");
  if (!text.endsWith("\n") || text.includes("\0")) throw failure();
  const rows = text.slice(0, -1).split("\n");
  if (rows.length === 0 || rows.length > 512) throw failure();
  const ids = new Set<string>();
  return rows.map((row) => {
    const fields = row.split(" ");
    const separator = fields.indexOf("-");
    const id = fields[0]!;
    const options = fields[5]?.split(",");
    if (
      separator < 6 ||
      fields.length !== separator + 4 ||
      !/^[1-9][0-9]*$/.test(id) ||
      ids.has(id) ||
      !options ||
      options.includes("ro") === options.includes("rw")
    )
      throw failure();
    ids.add(id);
    const point = fields[4]!.replace(/\\(040|011|012|134)/g, (_match, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
    if (!point.startsWith("/") || point.includes("\0") || paths.resolve(point) !== point)
      throw failure();
    return { id, point, readonly: options.includes("ro") };
  });
}

async function mountId(handle: Handle) {
  const text = await readProc(`/proc/self/fdinfo/${handle.fd}`);
  const found = text.split("\n").filter((row) => row.startsWith("mnt_id:"));
  if (found.length !== 1) throw failure();
  const match = /^mnt_id:\s+([1-9][0-9]*)$/.exec(found[0]!);
  if (!match) throw failure();
  return match[1]!;
}

async function verifyMount(
  handle: Handle,
  path: string,
  table: ReadonlyArray<Mount>,
  exact: boolean,
) {
  const containing = table.filter(
    (mount) => mount.point === "/" || path === mount.point || path.startsWith(mount.point + "/"),
  );
  const length = Math.max(...containing.map((mount) => mount.point.length));
  const matching = containing.filter((mount) => mount.point.length === length);
  if (
    matching.length !== 1 ||
    !matching[0]!.readonly ||
    (exact && matching[0]!.point !== path) ||
    (await mountId(handle)) !== matching[0]!.id
  )
    throw failure();
}

interface Directory {
  readonly path: string;
  readonly handle: Handle;
  readonly original: NativeStat;
}
async function verifyDirectories(
  directories: ReadonlyArray<Directory>,
  table: ReadonlyArray<Mount>,
) {
  for (const entry of directories) {
    const held = await entry.handle.stat({ bigint: true });
    const current = await stat(entry.path);
    if (
      !held.isDirectory() ||
      !current.isDirectory() ||
      !sameIdentity(entry.original, held) ||
      !sameIdentity(held, current) ||
      entry.original.mode !== held.mode ||
      held.mode !== current.mode ||
      (await files.realpath(fdPath(entry.handle))) !== entry.path
    )
      throw failure();
    await verifyMount(entry.handle, entry.path, table, false);
  }
}

async function openDirectory(path: string, parent: Directory | undefined, handles: Handle[]) {
  const source = parent ? `${fdPath(parent.handle)}/${paths.basename(path)}` : "/";
  const original = await stat(source);
  if (!original.isDirectory()) throw failure();
  const handle = await files.open(source, directoryFlags);
  handles.push(handle);
  if (
    !sameIdentity(original, await handle.stat({ bigint: true })) ||
    (await files.realpath(fdPath(handle))) !== path
  )
    throw failure();
  return { path, handle, original };
}

async function sdk() {
  const directory = process.env.PI_PACKAGE_DIR;
  if (!directory) throw Error("UNAVAILABLE");
  const handle = await files.open(paths.join(directory, "package.json"), readFlags);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.size < 0n || info.size > BigInt(maxManifestBytes))
      throw Error("UNAVAILABLE");
    decodeMetadata(
      (await boundedBytes(handle, maxManifestBytes, undefined, Number(info.size))).toString("utf8"),
    );
  } finally {
    await handle.close();
  }
  const loaded = await import("@earendil-works/pi-coding-agent");
  if (loaded.VERSION !== "0.99.1") throw Error("UNAVAILABLE");
  return loaded;
}

/**
 * Child-only Read consumer for Root's authenticated selected resources. Kernel
 * readonly mounts prove local confinement, not current role authority or package
 * hashes; Root keeps those fences and joins close after the host finishes.
 */
export async function makePiSelectedSkillRead(
  skills: NonNullable<PiWorkerBootstrap["resources"]>["skills"],
) {
  let selected: typeof Selection.Type;
  try {
    selected = Object.freeze(decodeSelection(skills).map((entry) => Object.freeze({ ...entry })));
  } catch {
    throw Error("INVALID_INPUT");
  }
  let closed = false;
  let closing: Promise<void> | undefined;
  let active: Promise<void> | undefined;
  let uncertain = false;
  const handles: Handle[] = [];
  const close = () => {
    closed = true;
    return (closing ??= (async () => {
      await active;
      await closeHandles(handles);
      if (uncertain) throw failure();
    })());
  };
  if (selected.length === 0)
    return Object.freeze({
      read: async (
        _input: ReadToolInput,
        _signal: AbortSignal,
      ): Promise<AgentToolResult<unknown>> => {
        throw failure();
      },
      close,
    });
  if (process.getBuiltinModule("os").platform() !== "linux") throw Error("UNAVAILABLE");
  const directories: Directory[] = [];
  const roots = new Map<string, Directory>();
  let loaded: Awaited<ReturnType<typeof sdk>>;
  try {
    let parent: Directory | undefined;
    for (const path of ["/", "/runtime", "/runtime/skills"]) {
      parent = await openDirectory(path, parent, handles);
      directories.push(parent);
    }
    for (const entry of selected) {
      const root = await openDirectory(`/runtime/skills/${entry.key}`, parent, handles);
      directories.push(root);
      roots.set(entry.key, root);
    }
    await verifyDirectories(directories, await mounts());
    loaded = await sdk();
    await verifyDirectories(directories, await mounts());
  } catch (error) {
    await closeHandles(handles);
    throw error;
  }

  const read = (
    original: ReadToolInput,
    signal: AbortSignal,
  ): Promise<AgentToolResult<unknown>> => {
    let input: typeof ReadInput.Type;
    try {
      input = Object.freeze({ ...decodeRead(original) });
    } catch {
      return Promise.reject(Error("INVALID_INPUT"));
    }
    const parts = input.path.split("/");
    const root = parts[1] === "runtime" && parts[2] === "skills" ? roots.get(parts[3]!) : undefined;
    const relative = parts.slice(4);
    if (closed || uncertain || active || !root || relative.length === 0 || relative.length > 32)
      return Promise.reject(failure());
    if (signal.aborted) return Promise.reject(Error("Operation aborted"));
    const callHandles: Handle[] = [];
    const pending = new Set<Promise<unknown>>();
    const operate = <A>(run: () => Promise<A>) => {
      const promise = run();
      pending.add(promise);
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      );
      return promise;
    };
    const execute = (async () => {
      checkSignal(signal);
      const parents: Directory[] = [...directories];
      let parent = root;
      for (const component of relative.slice(0, -1)) {
        parent = await openDirectory(`${parent.path}/${component}`, parent, callHandles);
        parents.push(parent);
        checkSignal(signal);
      }
      const target = `${fdPath(parent.handle)}/${relative.at(-1)!}`;
      const originalFile = await stat(target);
      const maximum = relative.join("/") === "t3-skill.json" ? maxManifestBytes : maxPackageBytes;
      if (
        !originalFile.isFile() ||
        originalFile.nlink !== 1n ||
        (originalFile.mode & 0o7777n) !== 0o400n ||
        originalFile.size < 0n ||
        originalFile.size > BigInt(maximum)
      )
        throw failure();
      const file = await files.open(target, readFlags);
      callHandles.push(file);
      const verify = async () => {
        checkSignal(signal);
        const table = await mounts();
        await verifyDirectories(parents, table);
        const current = await stat(input.path);
        const held = await file.stat({ bigint: true });
        if (
          !sameFile(originalFile, held) ||
          !sameFile(held, current) ||
          !current.isFile() ||
          current.nlink !== 1n ||
          (await files.realpath(fdPath(file))) !== input.path
        )
          throw failure();
        await verifyMount(file, input.path, table, true);
        checkSignal(signal);
      };
      await verify();
      let bytes: Promise<Buffer> | undefined;
      const capture = () =>
        (bytes ??= operate(async () => {
          await verify();
          const value = await boundedBytes(file, maximum, signal, Number(originalFile.size));
          await verify();
          return value;
        }));
      const descriptor = fdPath(file);
      const assertPath = (path: string) => {
        if (path !== descriptor) throw failure();
      };
      const result = await loaded
        .createReadTool("/", {
          autoResizeImages: false,
          operations: {
            access: (path) =>
              operate(async () => {
                assertPath(path);
                await verify();
              }),
            readFile: (path) => {
              assertPath(path);
              return capture();
            },
            detectImageMimeType: (path) =>
              operate(async () => {
                assertPath(path);
                await verify();
                // The public pinned SDK sniffs at most 4,100 bytes from this held FD.
                const mime = await loaded.detectSupportedImageMimeTypeFromFile(descriptor);
                await verify();
                if (mime) throw failure();
                return null;
              }),
          },
        })
        .execute("t3-selected-skill-read", { ...input, path: descriptor }, signal);
      if (result.isError || result.content.some((part) => part.type !== "text")) throw failure();
      checkSignal(signal);
      return result;
    })();
    const cleanup = execute
      .then(
        () => undefined,
        () => undefined,
      )
      .then(async () => {
        await Promise.allSettled(pending);
        await closeHandles(callHandles);
      });
    const joined = cleanup.then(
      () => {
        active = undefined;
      },
      () => {
        uncertain = true;
        active = undefined;
      },
    );
    active = joined;
    // SDK abort rejects promptly while close still waits for admitted descriptor I/O.
    return execute.then(
      async (result) => {
        await cleanup;
        checkSignal(signal);
        return result;
      },
      async (error: unknown) => {
        if (!signal.aborted) await cleanup;
        throw error;
      },
    );
  };
  return Object.freeze({ read, close });
}
