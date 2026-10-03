import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Schema from "effect/Schema";

const fs = process.getBuiltinModule("fs");
const files = fs.promises;
type Handle = Awaited<ReturnType<typeof files.open>>;
const metadata = (handle: Handle) => handle.stat({ bigint: true });
type Metadata = Awaited<ReturnType<typeof metadata>>;
const Settings = Schema.Struct({
  workspaceAccess: Schema.Literals(["readwrite", "readonly"]),
  protectedWorkspacePaths: Schema.Array(
    Schema.String.check(
      Schema.isMaxLength(4096),
      Schema.isPattern(/^\/workspace\/[^/\0]+$/),
      Schema.makeFilter((path) => !path.split("/").some((part) => part === "." || part === "..")),
    ),
  ).check(Schema.isMaxLength(128)),
});
const decodeSettings = Schema.decodeUnknownSync(Settings);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const environment = Object.freeze({
  HOME: "/workspace",
  TMPDIR: "/tmp",
  PATH: "/runtime:/bin",
  LANG: "C.UTF-8",
});
const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const fileFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const fdPath = (handle: Handle) => `/proc/${process.pid}/fd/${handle.fd}`;
const same = (left: Metadata, right: Metadata) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  (!left.isFile() || (left.size === right.size && left.nlink === right.nlink));
const safe = (stat: Metadata) =>
  stat.isDirectory()
    ? stat.nlink >= 1n
    : stat.isFile() && stat.nlink === 1n && stat.size >= 0n && stat.size <= 1_048_576n;
function fail(): never {
  throw Error("TOOL_FAILURE");
}
function unavailable(): never {
  throw Error("UNAVAILABLE");
}

const namespaceNames = ["mnt", "user", "pid", "net"];
const decimal = (value: string) => /^[1-9][0-9]{0,19}$/.test(value);
const mountPath = (value: string) =>
  value.replace(/\\(040|011|012|134)/g, (escape) =>
    String.fromCharCode(Number.parseInt(escape.slice(1), 8)),
  );
const parseMounts = (text: string) => {
  const lines = text.trimEnd().split("\n");
  if (lines.length > 512) unavailable();
  const ids = new Set<string>();
  return lines.map((line) => {
    const pieces = line.split(" - ");
    const left = pieces[0]?.split(" ") ?? [];
    const right = pieces[1]?.split(" ") ?? [];
    if (
      pieces.length !== 2 ||
      left.length < 6 ||
      left.length > 32 ||
      right.length !== 3 ||
      !decimal(left[0]!) ||
      !decimal(left[1]!) ||
      ids.has(left[0]!) ||
      !/^[0-9]+:[0-9]+$/.test(left[2]!) ||
      !left[4]!.startsWith("/")
    )
      unavailable();
    ids.add(left[0]!);
    const propagation = left.slice(6);
    // Pinned bwrap makes inherited mounts slaves. Reject shared (including shared/slave),
    // unbindable and unknown topology; privileged incoming host changes remain Root's fence.
    const nonShared =
      propagation.every((tag) => /^(master|propagate_from):[1-9][0-9]{0,19}$/.test(tag)) &&
      propagation.filter((tag) => tag.startsWith("master:")).length <= 1 &&
      propagation.filter((tag) => tag.startsWith("propagate_from:")).length <= 1 &&
      (!propagation.some((tag) => tag.startsWith("propagate_from:")) ||
        propagation.some((tag) => tag.startsWith("master:")));
    return {
      id: left[0]!,
      path: mountPath(left[4]!),
      options: left[5]!.split(","),
      nonShared,
      type: right[0]!,
    };
  });
};

type Protected = {
  path: string;
  handle: Handle;
  metadata: Metadata;
  ancestors: ReadonlyArray<Metadata>;
};

const commandPrefix = (access: "readwrite" | "readonly", overlays: ReadonlyArray<string>) => {
  const prefix = [
    "/runtime/t3-bwrap",
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--ro-bind",
    "/runtime",
    "/runtime",
    "--ro-bind",
    "/bin",
    "/bin",
    ...["/usr", "/lib", "/lib64"].flatMap((path) => ["--ro-bind-try", path, path]),
    access === "readonly" ? "--ro-bind" : "--bind",
    "/workspace",
    "/workspace",
    ...overlays.flatMap((path) => ["--remount-ro", path]),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    ...Object.entries(environment).flatMap(([name, value]) => ["--setenv", name, value]),
    "--remount-ro",
    "/",
    "--chdir",
    "/workspace",
    "--",
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-c",
  ]
    .map(quote)
    .join(" ");
  if (Buffer.byteLength(prefix) > 60_000) throw Error("INVALID_INPUT");
  return prefix;
};

/** Construct only inside Root's authorized outer worker; Root joins close before releasing it. */
export async function makePiBashToolIsolation(input: {
  localOperations: BashOperations;
  workspaceAccess: "readwrite" | "readonly";
  protectedWorkspacePaths: ReadonlyArray<string>;
}): Promise<{ operations: BashOperations; close: () => Promise<void> }> {
  let settings: typeof Settings.Type;
  try {
    settings = decodeSettings({
      workspaceAccess: input.workspaceAccess,
      protectedWorkspacePaths: input.protectedWorkspacePaths,
    });
    if (
      new Set(settings.protectedWorkspacePaths).size !== settings.protectedWorkspacePaths.length ||
      typeof input.localOperations.exec !== "function"
    )
      throw Error("INVALID_INPUT");
  } catch {
    throw Error("INVALID_INPUT");
  }
  const protectedPaths = Object.freeze([...settings.protectedWorkspacePaths]);
  const prefix = commandPrefix(settings.workspaceAccess, protectedPaths);
  if (HostProcessPlatform.defaultValue() !== "linux") throw Error("UNAVAILABLE");
  const exec = input.localOperations.exec.bind(input.localOperations);
  const owned = new Set<Handle>();
  let uncertain = false;
  const open = async (path: string, flags: number) => {
    const handle = await files.open(path, flags);
    owned.add(handle); // Register before any awaited metadata operation can fail.
    return handle;
  };
  const release = async (handles: ReadonlyArray<Handle>) => {
    let failed = false;
    for (const handle of handles.toReversed()) {
      try {
        await handle.close();
        owned.delete(handle);
      } catch {
        failed = true;
        uncertain = true;
      }
    }
    if (failed) fail();
  };
  const readProc = async (path: string, bound: number) => {
    const handle = await open(path, fileFlags);
    try {
      const buffer = Buffer.alloc(bound + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > bound) unavailable();
      return buffer.toString("utf8", 0, length);
    } finally {
      await release([handle]);
    }
  };
  const namespaces = async () =>
    Promise.all(
      namespaceNames.map(async (name) => {
        const identity = await files.readlink(`/proc/self/ns/${name}`);
        if (!new RegExp(`^${name}:\\[[1-9][0-9]{0,19}\\]$`).test(identity)) unavailable();
        return identity;
      }),
    );
  let namespaceBaseline: ReadonlyArray<string>;
  let workspace: Handle;
  let workspaceMetadata: Metadata;
  const protectedObjects: Protected[] = [];
  // These are prerequisites of Root's owned outer cage, not caller-provided grants.
  // Root also fences workspace/Git lifetime against writers outside this namespace.
  const verifyPolicy = async () => {
    const currentNamespaces = await namespaces();
    if (currentNamespaces.some((identity, index) => identity !== namespaceBaseline[index]))
      unavailable();
    const status = await readProc("/proc/self/status", 8192);
    for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs"]) {
      const values = status.split("\n").filter((line) => line.startsWith(`${name}:`));
      const value = values[0]?.slice(name.length + 1).trim();
      if (
        values.length !== 1 ||
        (name === "NoNewPrivs" ? value !== "1" : !/^0{16}$/.test(value ?? ""))
      )
        unavailable();
    }
    const mounts = parseMounts(await readProc("/proc/self/mountinfo", 65_536));
    const exact = (path: string) => {
      const found = mounts.filter((mount) => mount.path === path);
      if (found.length !== 1 || !found[0]!.nonShared) unavailable();
      return found[0]!;
    };
    const root = exact("/");
    const assigned = exact("/workspace");
    if (
      !root.options.includes("ro") ||
      (!assigned.options.includes(settings.workspaceAccess === "readwrite" ? "rw" : "ro") &&
        !assigned.options.includes("rw"))
    )
      unavailable();
    if (exact("/proc").type !== "proc") unavailable();
    // Recursive bind must not import propagating mounts or writable protected descendants.
    for (const mount of mounts.filter((entry) => entry.path.startsWith("/workspace/"))) {
      if (!mount.nonShared) unavailable();
      if (
        protectedPaths.some((path) => mount.path === path || mount.path.startsWith(path + "/")) &&
        !mount.options.includes("ro")
      )
        unavailable();
    }
    const join = async (handle: Handle, path: string) => {
      const fields = (await readProc(`/proc/self/fdinfo/${handle.fd}`, 4096))
        .split("\n")
        .filter((line) => line.startsWith("mnt_id:"));
      const id = fields[0]?.slice("mnt_id:".length).trim();
      if (fields.length !== 1 || !decimal(id ?? "") || exact(path).id !== id) unavailable();
    };
    await join(workspace, "/workspace");
    for (const object of protectedObjects) {
      if (!exact(object.path).options.includes("ro")) unavailable();
      await join(object.handle, object.path);
    }
  };
  const verifyWorkspace = async () => {
    const current = await files.lstat("/workspace", { bigint: true });
    if (
      !current.isDirectory() ||
      !same(workspaceMetadata, current) ||
      !same(workspaceMetadata, await workspace.stat({ bigint: true })) ||
      (await files.realpath(fdPath(workspace))) !== "/workspace"
    )
      fail();
  };
  // Only final objects survive a walk. Intermediate descriptors stay bounded even for deep paths.
  const walk = async (path: string, baseline?: Protected) => {
    let parent = workspace;
    const transient = new Set<Handle>();
    const ancestors: Metadata[] = [];
    const components = path.slice("/workspace/".length).split("/");
    let expected = "/workspace";
    try {
      for (let index = 0; index < components.length; index++) {
        const last = index === components.length - 1;
        const childPath = `${fdPath(parent)}/${components[index]}`;
        const before = await files.lstat(childPath, { bigint: true });
        if (last ? !safe(before) : !before.isDirectory() || before.nlink < 1n) fail();
        const handle = await open(childPath, before.isDirectory() ? directoryFlags : fileFlags);
        transient.add(handle);
        const metadata = await handle.stat({ bigint: true });
        expected += `/${components[index]}`;
        if (
          !same(before, metadata) ||
          (await files.realpath(fdPath(handle))) !== expected ||
          (await files.realpath(fdPath(parent))) !== expected.slice(0, expected.lastIndexOf("/"))
        )
          fail();
        if (baseline && !same(last ? baseline.metadata : baseline.ancestors[index]!, metadata))
          fail();
        if (parent !== workspace) {
          await release([parent]);
          transient.delete(parent);
        }
        parent = handle;
        if (!last) ancestors.push(metadata);
      }
      if (baseline) {
        const original = await baseline.handle.stat({ bigint: true });
        if (
          !safe(original) ||
          !same(baseline.metadata, original) ||
          (await files.realpath(fdPath(baseline.handle))) !== path
        )
          fail();
      } else {
        transient.delete(parent);
        return {
          path,
          handle: parent,
          metadata: await parent.stat({ bigint: true }),
          ancestors: Object.freeze(ancestors),
        };
      }
    } finally {
      await release([...transient]);
    }
  };
  try {
    workspace = await open("/workspace", directoryFlags);
    workspaceMetadata = await workspace.stat({ bigint: true });
    if (!workspaceMetadata.isDirectory() || workspaceMetadata.nlink < 1n) fail();
    await verifyWorkspace();
    for (const path of protectedPaths) {
      const admitted = await walk(path);
      if (!admitted) fail();
      protectedObjects.push(admitted);
    }
    await verifyWorkspace();
    namespaceBaseline = Object.freeze(await namespaces());
    await verifyPolicy();
    let closed = false;
    let closing: Promise<void> | undefined;
    let verification = Promise.resolve();
    const pending = new Set<Promise<{ exitCode: number | null }>>();
    const operations = Object.freeze<BashOperations>({
      exec(command, cwd, options) {
        if (closed || uncertain) return Promise.reject(Error("UNAVAILABLE"));
        const execution = (async () => {
          if (cwd !== "/workspace" || typeof command !== "string" || command.includes("\0"))
            throw Error("INVALID_INPUT");
          const isolated = `exec ${prefix} ${quote(command)}`;
          if (Buffer.byteLength(isolated) > 120_000) throw Error("INVALID_INPUT");
          if (options.signal?.aborted) throw Error("aborted");
          const admitted = verification.then(async () => {
            try {
              await verifyWorkspace();
              await verifyPolicy();
              for (const object of protectedObjects) await walk(object.path, object);
              await verifyWorkspace();
              await verifyPolicy();
            } catch (error) {
              if (error instanceof Error && error.message === "UNAVAILABLE") throw error;
              fail();
            }
          });
          verification = admitted.catch(() => undefined);
          await admitted;
          if (uncertain) fail();
          if (options.signal?.aborted) throw Error("aborted");
          return await exec(isolated, "/workspace", { ...options, env: environment });
        })();
        pending.add(execution);
        void execution.then(
          () => pending.delete(execution),
          () => pending.delete(execution),
        );
        return execution;
      },
    });
    return Object.freeze({
      operations,
      close() {
        closed = true;
        return (closing ??= (async () => {
          // SDK settlement joins that call, not every descendant; Root's managed owner remains required.
          await Promise.allSettled(pending);
          await release([...owned]);
          if (uncertain) fail();
        })());
      },
    });
  } catch (error) {
    await release([...owned]);
    if (error instanceof Error && ["INVALID_INPUT", "UNAVAILABLE"].includes(error.message))
      throw error;
    return fail();
  }
}
