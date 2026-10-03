import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { makePiBashToolIsolation } from "./PiBashToolIsolation.ts";

const fs = process.getBuiltinModule("fs").promises;
const paths = process.getBuiltinModule("path");
const originalOpen = fs.open.bind(fs);
const originalLstat = fs.lstat.bind(fs);
const originalRealpath = fs.realpath.bind(fs);
type Handle = Awaited<ReturnType<typeof fs.open>>;
const local = () => ({ exec: vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 0 })) });
let fixture: string;
let handles: Handle[];
let mountinfo: string;
let status: string;
let protectedMountId: string;
let namespaceSuffix: string;

beforeEach(async () => {
  fixture = await fs.mkdtemp(paths.join(process.getBuiltinModule("os").tmpdir(), "pi-bash-owned-"));
  await fs.mkdir(paths.join(fixture, "protected"));
  await fs.writeFile(
    paths.join(fixture, "protected", "instructions"),
    "ordinary protected fixture",
  );
  await fs.writeFile(paths.join(fixture, ".git"), "gitdir: ordinary-fixture");
  handles = [];
  mountinfo =
    [
      "1 9 0:1 / / ro - tmpfs tmpfs ro",
      "2 1 0:2 / /workspace rw - tmpfs tmpfs rw",
      "3 2 0:3 / /workspace/.git ro - tmpfs tmpfs rw",
      "4 2 0:4 / /workspace/protected ro - tmpfs tmpfs rw",
      "5 1 0:5 / /proc rw - proc proc rw",
    ].join("\n") + "\n";
  status =
    ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]
      .map((name) => `${name}:\t0000000000000000\n`)
      .join("") + "NoNewPrivs:\t1\n";
  protectedMountId = "3";
  namespaceSuffix = "1";
  const mountIds = new Map<number, string>();
  const mapped = (value: string) =>
    value === "/workspace" || value.startsWith("/workspace/")
      ? fixture + value.slice("/workspace".length)
      : value;
  vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
    if (typeof path === "string" && path.startsWith("/proc/self/")) {
      const contents =
        path === "/proc/self/mountinfo"
          ? mountinfo
          : path === "/proc/self/status"
            ? status
            : `mnt_id:\t${mountIds.get(Number(path.slice("/proc/self/fdinfo/".length))) ?? "0"}\n`;
      const synthetic = paths.join(fixture, "kernel-metadata");
      await fs.writeFile(synthetic, contents);
      path = synthetic;
    }
    const handle = await originalOpen(typeof path === "string" ? mapped(path) : path, flags, mode);
    handles.push(handle);
    const identity = await originalRealpath(`/proc/${process.pid}/fd/${handle.fd}`);
    mountIds.set(
      handle.fd,
      identity === fixture
        ? "2"
        : identity === paths.join(fixture, ".git")
          ? protectedMountId
          : identity === paths.join(fixture, "protected")
            ? "4"
            : "0",
    );
    return handle;
  });
  vi.spyOn(fs, "readlink").mockImplementation(async (path) => {
    if (typeof path === "string" && path.startsWith("/proc/self/ns/"))
      return `${path.slice("/proc/self/ns/".length)}:[${namespaceSuffix}]`;
    throw Error("unexpected readlink");
  });
  vi.spyOn(fs, "lstat").mockImplementation((path, options) =>
    originalLstat(typeof path === "string" ? mapped(path) : path, options),
  );
  vi.spyOn(fs, "realpath").mockImplementation(async (path, options) => {
    const result = await originalRealpath(path, options);
    return typeof result === "string" && (result === fixture || result.startsWith(fixture + "/"))
      ? "/workspace" + result.slice(fixture.length)
      : result;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(handles.map((handle) => handle.close()));
  await fs.rm(fixture, { recursive: true, force: true });
});

const construct = (
  localOperations: BashOperations = local(),
  protectedWorkspacePaths = ["/workspace/.git", "/workspace/protected"],
) =>
  makePiBashToolIsolation({
    localOperations,
    workspaceAccess: "readwrite",
    protectedWorkspacePaths,
  });

describe("Pi Bash tool isolation ownership", () => {
  it("rejects unsupported platforms before opening anything", async () => {
    vi.spyOn(HostProcessPlatform, "defaultValue").mockReturnValue("darwin");
    await expect(construct()).rejects.toThrow("UNAVAILABLE");
    expect(handles).toHaveLength(0);
  });

  it("holds original regular-file and directory handles until its idempotent close", async () => {
    const owner = await construct();
    const held = handles.filter((handle) => handle.fd >= 0);
    expect(held).toHaveLength(3);
    expect((await held[0]!.stat()).isDirectory()).toBe(true);
    expect((await held[1]!.stat()).isFile()).toBe(true);
    expect((await held[2]!.stat()).isDirectory()).toBe(true);
    const closing = owner.close();
    expect(owner.close()).toBe(closing);
    await closing;
    expect(handles.every((handle) => handle.fd === -1)).toBe(true);
    await expect(
      owner.operations.exec("printf hello", "/workspace", { onData: () => {} }),
    ).rejects.toThrow("UNAVAILABLE");
  });

  it("joins an admitted backend promise before releasing original handles", async () => {
    const entered = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<{ exitCode: number }>();
    const localOperations: BashOperations = {
      exec: () => {
        entered.resolve();
        return finished.promise;
      },
    };
    const owner = await construct(localOperations);
    const execution = owner.operations.exec("printf hello", "/workspace", { onData: () => {} });
    await entered.promise;
    const held = handles.filter((handle) => handle.fd >= 0);
    const closing = owner.close();
    await expect(
      owner.operations.exec("printf later", "/workspace", { onData: () => {} }),
    ).rejects.toThrow("UNAVAILABLE");
    expect(held.every((handle) => handle.fd >= 0)).toBe(true);
    finished.resolve({ exitCode: 23 });
    await expect(execution).resolves.toEqual({ exitCode: 23 });
    await closing;
    expect(handles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it("joins acquired handles after a construction open fails", async () => {
    await expect(
      construct(local(), ["/workspace/protected", "/workspace/missing"]),
    ).rejects.toThrow("TOOL_FAILURE");
    expect(handles.length).toBeGreaterThan(0);
    expect(handles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it("registers an open before a failing metadata operation", async () => {
    const open = vi.mocked(fs.open);
    const implementation = open.getMockImplementation()!;
    open.mockImplementation(async (...args) => {
      const handle = await implementation(...args);
      vi.spyOn(handle, "stat").mockRejectedValue(Error("synthetic metadata failure"));
      return handle;
    });
    await expect(construct()).rejects.toThrow("TOOL_FAILURE");
    expect(handles).toHaveLength(1);
    expect(handles[0]!.fd).toBe(-1);
  });

  it("reports uncertain close while attempting every owned close", async () => {
    const owner = await construct();
    const held = handles.filter((handle) => handle.fd >= 0);
    vi.spyOn(held[1]!, "close").mockRejectedValue(Error("synthetic close failure"));
    await expect(owner.close()).rejects.toThrow("TOOL_FAILURE");
    expect(held[0]!.fd).toBe(-1);
    expect(held[2]!.fd).toBe(-1);
    await expect(
      owner.operations.exec("printf hello", "/workspace", { onData: () => {} }),
    ).rejects.toThrow("UNAVAILABLE");
    vi.mocked(held[1]!.close).mockRestore();
  });

  it("retains ownership after backend rejection or direct throw until explicitly closed", async () => {
    for (const synchronous of [false, true]) {
      const failure = Error("aborted");
      const localOperations = local();
      localOperations.exec.mockImplementation(() => {
        if (synchronous) throw failure;
        return Promise.reject(failure);
      });
      const owner = await construct(localOperations);
      await expect(
        owner.operations.exec("printf hello", "/workspace", { onData: () => {} }),
      ).rejects.toBe(failure);
      expect(handles.filter((handle) => handle.fd >= 0)).toHaveLength(3);
      await owner.close();
      expect(handles.every((handle) => handle.fd === -1)).toBe(true);
      expect(localOperations.exec).toHaveBeenCalledTimes(1);
    }
  });

  it("does not spawn an already canceled command", async () => {
    const localOperations = local();
    const owner = await construct(localOperations);
    const controller = new AbortController();
    controller.abort();
    await expect(
      owner.operations.exec("printf hello", "/workspace", {
        onData: () => {},
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
    expect(localOperations.exec).not.toHaveBeenCalled();
    await owner.close();
  });

  it("joins a pending admission open on cancellation and close", async () => {
    const localOperations = local();
    const owner = await construct(localOperations);
    const opened = Promise.withResolvers<void>();
    const releaseOpen = Promise.withResolvers<void>();
    const open = vi.mocked(fs.open);
    const implementation = open.getMockImplementation()!;
    open.mockImplementationOnce(async (...args) => {
      const handle = await implementation(...args);
      opened.resolve();
      await releaseOpen.promise;
      return handle;
    });
    const controller = new AbortController();
    const execution = owner.operations.exec("printf hello", "/workspace", {
      onData: () => {},
      signal: controller.signal,
    });
    const rejected = expect(execution).rejects.toThrow("aborted");
    await opened.promise;
    controller.abort();
    const closing = owner.close();
    expect(handles.filter((handle) => handle.fd >= 0)).toHaveLength(4);
    releaseOpen.resolve();
    await rejected;
    await closing;
    expect(handles.every((handle) => handle.fd === -1)).toBe(true);
    expect(localOperations.exec).not.toHaveBeenCalled();
  });

  it("replaces startup env and preserves SDK output, timeout, abort and status", async () => {
    const chunks: Buffer[] = [];
    const controller = new AbortController();
    const localOperations: BashOperations = {
      async exec(_command, cwd, options) {
        expect(cwd).toBe("/workspace");
        expect(options.signal).toBe(controller.signal);
        expect(options.timeout).toBe(0.3);
        expect(options.env).toEqual({
          HOME: "/workspace",
          TMPDIR: "/tmp",
          PATH: "/runtime:/bin",
          LANG: "C.UTF-8",
        });
        options.onData(Buffer.from("stdout-stderr"));
        return { exitCode: 23 };
      },
    };
    const owner = await construct(localOperations);
    await expect(
      owner.operations.exec("exit 23", "/workspace", {
        onData: (chunk) => chunks.push(chunk),
        signal: controller.signal,
        timeout: 0.3,
        env: { BASH_ENV: "/state/startup", ENV: "/state/startup" },
      }),
    ).resolves.toEqual({ exitCode: 23 });
    expect(Buffer.concat(chunks).toString()).toBe("stdout-stderr");
    await owner.close();
  });
});

describe("Pi Bash tool isolation admission bounds", () => {
  for (const workspaceAccess of ["writable", "", "readWrite", null, undefined])
    it(`rejects malformed access ${String(workspaceAccess)}`, async () => {
      await expect(
        Reflect.apply(makePiBashToolIsolation, undefined, [
          { localOperations: local(), workspaceAccess, protectedWorkspacePaths: [] },
        ]),
      ).rejects.toThrow("INVALID_INPUT");
      expect(handles).toHaveLength(0);
    });

  for (const path of [
    "/workspace",
    "/workspace/",
    "/state/private",
    "workspace/.git",
    "/workspace-other/.git",
    "/workspace/../state",
    "/workspace/./.git",
    "/workspace//.git",
    "/workspace/.git/",
    "/workspace/protected/instructions",
    "/workspace/zero" + String.fromCharCode(0) + "byte",
    "/workspace/" + "x".repeat(4096),
  ])
    it(`rejects noncanonical protected path ${path.slice(0, 50)}`, async () => {
      await expect(construct(local(), [path])).rejects.toThrow("INVALID_INPUT");
      expect(handles).toHaveLength(0);
    });

  it("rejects duplicate paths and more than 128 overlays", async () => {
    for (const protectedPaths of [
      ["/workspace/.git", "/workspace/.git"],
      Array.from({ length: 129 }, (_, index) => `/workspace/${index}`),
    ])
      await expect(construct(local(), protectedPaths)).rejects.toThrow("INVALID_INPUT");
    expect(handles).toHaveLength(0);
  });

  it("enforces quoted UTF-8 prefix bounds before acquiring descriptors", async () => {
    for (const name of ["'".repeat(1000), "😀".repeat(1000)])
      await expect(
        construct(
          local(),
          Array.from({ length: 16 }, (_, index) => `/workspace/${index}${name}`),
        ),
      ).rejects.toThrow("INVALID_INPUT");
    expect(handles).toHaveLength(0);
  });

  it("rejects invalid cwd, NUL and oversized commands before execution", async () => {
    const localOperations = local();
    const owner = await construct(localOperations);
    await expect(
      owner.operations.exec("printf hello", "/state", { onData: () => {} }),
    ).rejects.toThrow("INVALID_INPUT");
    for (const command of [
      "zero" + String.fromCharCode(0) + "byte",
      "'".repeat(30_000),
      "😀".repeat(30_000),
    ])
      await expect(
        owner.operations.exec(command, "/workspace", { onData: () => {} }),
      ).rejects.toThrow("INVALID_INPUT");
    expect(localOperations.exec).not.toHaveBeenCalled();
    await owner.close();
  });
});

describe("Pi Bash inherited mount admission", () => {
  for (const defect of [
    "missing",
    "writable",
    "stacked",
    "propagating",
    "shared-slave",
    "unbindable",
    "malformed-tag",
    "missing-master",
    "wrong-fd",
    "caps",
    "startup",
    "oversized",
  ])
    it(`rejects ${defect} kernel policy without executing and closes admissions`, async () => {
      if (defect === "missing") mountinfo = mountinfo.replace(/^3 .*\n/m, "");
      if (defect === "writable")
        mountinfo = mountinfo.replace("/workspace/.git ro", "/workspace/.git rw");
      if (defect === "stacked") mountinfo += "6 2 0:6 / /workspace/.git ro - tmpfs tmpfs ro\n";
      if (defect === "propagating")
        mountinfo = mountinfo.replace("/workspace rw -", "/workspace rw shared:1 -");
      if (defect === "shared-slave")
        mountinfo = mountinfo.replace(
          "/workspace/.git ro -",
          "/workspace/.git ro shared:1 master:2 -",
        );
      if (defect === "unbindable")
        mountinfo = mountinfo.replace("/workspace/.git ro -", "/workspace/.git ro unbindable -");
      if (defect === "malformed-tag")
        mountinfo = mountinfo.replace(
          "/workspace/.git ro -",
          "/workspace/.git ro master:garbage -",
        );
      if (defect === "missing-master")
        mountinfo = mountinfo.replace(
          "/workspace/.git ro -",
          "/workspace/.git ro propagate_from:1 -",
        );
      if (defect === "wrong-fd") protectedMountId = "2";
      if (defect === "caps")
        status = status.replace("CapEff:\t0000000000000000", "CapEff:\t0000000000000001");
      if (defect === "startup") status = status.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0");
      if (defect === "oversized") mountinfo = "x".repeat(65_537);
      const localOperations = local();
      await expect(construct(localOperations)).rejects.toThrow("UNAVAILABLE");
      expect(localOperations.exec).not.toHaveBeenCalled();
      expect(handles.every((handle) => handle.fd === -1)).toBe(true);
    });

  it("checks current kernel policy and namespace identity before each backend call", async () => {
    const localOperations = local();
    const owner = await construct(localOperations);
    mountinfo = mountinfo.replace("/workspace/.git ro", "/workspace/.git rw");
    await expect(
      owner.operations.exec("printf ordinary", "/workspace", { onData: () => {} }),
    ).rejects.toThrow("UNAVAILABLE");
    expect(localOperations.exec).not.toHaveBeenCalled();
    namespaceSuffix = "2";
    await expect(
      owner.operations.exec("printf ordinary", "/workspace", { onData: () => {} }),
    ).rejects.toThrow("UNAVAILABLE");
    await owner.close();
    expect(handles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it("accepts the actual owner's plain slave propagation while retaining original readonly mounts", async () => {
    mountinfo = mountinfo
      .replace("/workspace rw -", "/workspace rw master:158 -")
      .replace("/workspace/.git ro -", "/workspace/.git ro master:158 -")
      .replace(
        "/workspace/protected ro -",
        "/workspace/protected ro master:158 propagate_from:158 -",
      );
    const localOperations = local();
    const owner = await construct(localOperations);
    await expect(
      owner.operations.exec("printf ordinary", "/workspace", { onData: () => {} }),
    ).resolves.toEqual({ exitCode: 0 });
    await owner.close();
    expect(localOperations.exec).toHaveBeenCalledTimes(1);
    expect(handles.every((handle) => handle.fd === -1)).toBe(true);
  });
});
