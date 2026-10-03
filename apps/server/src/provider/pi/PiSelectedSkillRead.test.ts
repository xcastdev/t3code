import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { ManagedSkillManifest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  hashSkillPackage,
  inspectSkillPackage,
  writeSkillPackageContents,
} from "../../skills/SkillPackage.ts";
import { makePiSelectedSkillRead } from "./PiSelectedSkillRead.ts";

const fs = process.getBuiltinModule("fs").promises;
const os = process.getBuiltinModule("os");
const modules = process.getBuiltinModule("module");
const sdkDirectory = new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent"))
  .pathname;
const previousSdk = process.env.PI_PACKAGE_DIR;
const decodeManifest = Schema.decodeSync(ManagedSkillManifest);
const encodeEvidence = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const roots: string[] = [];
const readers: Awaited<ReturnType<typeof makePiSelectedSkillRead>>[] = [];
afterEach(async () => {
  await Promise.allSettled(readers.splice(0).map((reader) => reader.close()));
  vi.restoreAllMocks();
  modules.syncBuiltinESMExports();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  if (previousSdk === undefined) delete process.env.PI_PACKAGE_DIR;
  else process.env.PI_PACKAGE_DIR = previousSdk;
});
const selected = () => [
  { key: "example", path: "/runtime/skills/example/SKILL.md", description: "Fixture" },
];
const signal = () => new AbortController().signal;
const text = (
  result: Awaited<ReturnType<Awaited<ReturnType<typeof makePiSelectedSkillRead>>["read"]>>,
) =>
  result.content.map((part) => (part.type === "text" ? part.text : "unexpected image")).join("\n");

// Only mountinfo and fdinfo are synthetic. File bytes, descriptors, nofollow,
// stats and the pinned public SDK are real; this is not a native cage proof.
async function fixture(
  entries: Record<string, string | Buffer> = {
    "SKILL.md": "one\ntwo\nthree\n",
    "assets/note.txt": "asset",
  },
) {
  const root = await fs.mkdtemp(os.tmpdir() + "/pi-selected-read-");
  roots.push(root);
  const canonical = "/runtime/skills/example";
  for (const [relative, bytes] of Object.entries(entries)) {
    const target = root + canonical + "/" + relative;
    await fs.mkdir(process.getBuiltinModule("path").dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { mode: 0o400 });
  }
  let topology =
    "1 0 0:1 / / ro - tmpfs tmpfs rw\n" +
    Object.keys(entries)
      .map((relative, i) => `${10 + i} 1 0:2 / ${canonical}/${relative} ro - ext4 fixture rw\n`)
      .join("");
  const ids = new Map<number, number>();
  const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  const open = fs.open;
  const realpath = fs.realpath;
  const lstat = fs.lstat;
  const translate = (path: string) =>
    path === "/" ? root : path.startsWith("/runtime") ? root + path : path;
  vi.spyOn(fs, "lstat").mockImplementation((...args) =>
    lstat(typeof args[0] === "string" ? translate(args[0]) : args[0], args[1]),
  );
  vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
    const value = await realpath(...args);
    return typeof value === "string" && (value === root || value.startsWith(root + "/"))
      ? value.slice(root.length) || "/"
      : value;
  });
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const name = String(args[0]);
    if (name === "/proc/self/mountinfo" || name.startsWith("/proc/self/fdinfo/")) {
      const target = root + "/proc-fixture-" + handles.length;
      const contents = name.endsWith("mountinfo")
        ? topology
        : `pos:\t0\nflags:\t0100000\nmnt_id:\t${ids.get(Number(name.split("/").at(-1)))}\n`;
      await fs.writeFile(target, contents);
      const handle = await open(target, args[1]);
      handles.push(handle);
      return handle;
    }
    const handle = await open(
      typeof args[0] === "string" ? translate(args[0]) : args[0],
      args[1],
      args[2],
    );
    const physical = await realpath(`/proc/self/fd/${handle.fd}`);
    const relative = String(physical).slice((root + canonical + "/").length);
    ids.set(
      handle.fd,
      Object.hasOwn(entries, relative) ? 10 + Object.keys(entries).indexOf(relative) : 1,
    );
    handles.push(handle);
    return handle;
  });
  modules.syncBuiltinESMExports();
  process.env.PI_PACKAGE_DIR = sdkDirectory;
  const make = async () => {
    const reader = await makePiSelectedSkillRead(selected());
    readers.push(reader);
    return reader;
  };
  return {
    root,
    make,
    handles,
    setTopology: (value: string) => {
      topology = value;
    },
    topology: () => topology,
  };
}

describe("selected skill native Read consumer", () => {
  it("keeps detector cleanup uncertainty visible and restores only its captured native handle", async () => {
    const { make, handles } = await fixture();
    const reader = await make();
    const fixtureOpen = vi.mocked(fs.open).getMockImplementation()!;
    let captured:
      | { handle: Awaited<ReturnType<typeof fs.open>>; close: () => Promise<void> }
      | undefined;
    let faultCalls = 0;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await fixtureOpen(...args);
      if (!captured && /^\/proc\/self\/fd\/\d+$/.test(String(args[0])) && args[1] === "r") {
        captured = { handle, close: handle.close.bind(handle) };
        vi.spyOn(handle, "close").mockImplementation(async () => {
          faultCalls++;
          throw Error("synthetic detector close failure before native close");
        });
      }
      return handle;
    });
    modules.syncBuiltinESMExports();
    const outcome = (promise: Promise<unknown>) =>
      promise.then(
        () => "success",
        (error: unknown) => String(error),
      );
    let observations: unknown;
    try {
      const read = await outcome(reader.read({ path: selected()[0]!.path }, signal()));
      const subsequent = await outcome(reader.read({ path: selected()[0]!.path }, signal()));
      const close = await outcome(reader.close());
      if (!captured) throw Error("DETECTOR_HANDLE_NOT_CAPTURED");
      const identity = await captured.handle.stat({ bigint: true });
      observations = {
        read,
        subsequent,
        close,
        fd: captured.handle.fd,
        dev: String(identity.dev),
        ino: String(identity.ino),
        faultCalls,
      };
      expect(captured.handle.fd).not.toBe(-1);
      expect(faultCalls).toBe(1);
      expect(read).toBe("Error: TOOL_FAILURE");
      expect(subsequent).toBe("Error: TOOL_FAILURE");
      expect(close).toBe("Error: TOOL_FAILURE");
    } finally {
      if (captured && captured.handle.fd !== -1) await captured.close();
      expect(handles.every((handle) => handle.fd === -1)).toBe(true);
      const evidence = process.env.PI_SELECTED_SKILL_READ_REPAIR_EVIDENCE_DIRECTORY;
      if (evidence)
        await fs.writeFile(
          evidence + "/detector-fault.json",
          JSON.stringify(
            {
              observations,
              restored: captured?.handle.fd === -1,
              allFixtureHandlesClosed: handles.every((handle) => handle.fd === -1),
            },
            null,
            2,
          ),
        );
    }
  });

  it("joins the public detector after cancellation without treating successful cleanup as uncertainty", async () => {
    const { make, handles } = await fixture();
    const reader = await make();
    const fixtureOpen = vi.mocked(fs.open).getMockImplementation()!;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let detector: Awaited<ReturnType<typeof fs.open>> | undefined;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await fixtureOpen(...args);
      if (/^\/proc\/self\/fd\/\d+$/.test(String(args[0])) && args[1] === "r") {
        detector = handle;
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
          const result = await read(...readArgs);
          entered.resolve();
          await release.promise;
          return result;
        });
      }
      return handle;
    });
    modules.syncBuiltinESMExports();
    const controller = new AbortController();
    const pending = reader.read({ path: selected()[0]!.path }, controller.signal).then(
      () => "unexpected",
      (error: unknown) => String(error),
    );
    try {
      await entered.promise;
      controller.abort();
      expect(await pending).toBe("Error: Operation aborted");
      const closing = reader.close();
      let closed = false;
      void closing.then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(detector?.fd).not.toBe(-1);
      release.resolve();
      await closing;
      expect(handles.every((handle) => handle.fd === -1)).toBe(true);
    } finally {
      release.resolve();
      await pending;
    }
  });

  effectIt.effect(
    "reads literal asset names accepted by the actual managed package writer, hash and inspector",
    () =>
      Effect.gen(function* () {
        const packagePath = yield* Effect.promise(() =>
          fs.mkdtemp(os.tmpdir() + "/pi-selected-package-"),
        );
        roots.push(packagePath);
        const assets = ["assets/@notes.txt", "assets/~scratch.txt", "assets/file:report.txt"];
        const manifest = decodeManifest({
          schemaVersion: 1,
          kind: "managed-skill",
          id: "reader-example",
          key: "example",
          scope: "global",
          revision: { revision: 1, hash: "a".repeat(64) },
          origin: "created",
          ownership: "t3",
        });
        const inspection = yield* Effect.gen(function* () {
          yield* writeSkillPackageContents({
            packagePath,
            manifest,
            content: {
              key: manifest.key,
              name: "Reader package",
              body: "Literal packaged assets",
              assetPaths: assets,
            },
          });
          yield* Effect.promise(async () => {
            await fs.mkdir(packagePath + "/assets");
            for (const relative of assets)
              await fs.writeFile(packagePath + "/" + relative, "benign " + relative);
          });
          const hash = yield* hashSkillPackage(packagePath);
          yield* writeSkillPackageContents({
            packagePath,
            manifest: { ...manifest, revision: { revision: 1, hash } },
          });
          return yield* inspectSkillPackage({
            packagePath,
            expectedKey: manifest.key,
            expectedScope: "global",
          });
        }).pipe(Effect.provide(NodeServices.layer));
        expect(inspection.validity).toBe("valid");
        expect(inspection.diagnostics).toEqual([]);
        expect(inspection.content?.assetPaths).toEqual(assets);
        expect(inspection.manifest?.revision.hash).toBe(inspection.hash);
        const entries: Record<string, Buffer> = {};
        for (const relative of ["SKILL.md", "t3-skill.json", ...assets])
          entries[relative] = yield* Effect.promise(() =>
            fs.readFile(packagePath + "/" + relative),
          );
        const { make, handles } = yield* Effect.promise(() => fixture(entries));
        const reader = yield* Effect.promise(make);
        for (const relative of assets)
          expect(
            text(
              yield* Effect.promise(() =>
                reader.read({ path: "/runtime/skills/example/" + relative }, signal()),
              ),
            ),
          ).toBe("benign " + relative);
        yield* Effect.promise(reader.close);
        expect(handles.every((handle) => handle.fd === -1)).toBe(true);
        const evidence = process.env.PI_SELECTED_SKILL_READ_REPAIR_EVIDENCE_DIRECTORY;
        if (evidence)
          yield* Effect.promise(() =>
            fs.writeFile(evidence + "/package-compatibility.json", encodeEvidence(inspection)),
          );
      }),
  );
  it("keeps empty selection inert without filesystem or SDK setup", async () => {
    delete process.env.PI_PACKAGE_DIR;
    const open = vi.spyOn(fs, "open");
    const reader = await makePiSelectedSkillRead([]);
    expect(Object.isFrozen(reader)).toBe(true);
    expect(Object.keys(reader)).toEqual(["read", "close"]);
    await expect(
      reader.read({ path: "/runtime/skills/example/SKILL.md" }, signal()),
    ).rejects.toThrow();
    await reader.close();
    await reader.close();
    expect(open).not.toHaveBeenCalled();
  });

  it("reads selected SKILL.md and relative assets through actual SDK paging", async () => {
    const { make } = await fixture();
    const reader = await make();
    expect(
      text(await reader.read({ path: selected()[0]!.path, offset: 2, limit: 1 }, signal())),
    ).toBe("two\n\n[2 more lines in file. Use offset=3 to continue.]");
    expect(
      text(await reader.read({ path: "/runtime/skills/example/assets/note.txt" }, signal())),
    ).toBe("asset");
    await expect(reader.read({ path: selected()[0]!.path, offset: 99 }, signal())).rejects.toThrow(
      "Offset 99 is beyond end of file (4 lines total)",
    );
  });

  it.each([
    "",
    "SKILL.md",
    "@/runtime/skills/example/SKILL.md",
    "file:///runtime/skills/example/SKILL.md",
    "~/SKILL.md",
    "/runtime/skills/example/../SKILL.md",
    "/runtime/skills/example/./SKILL.md",
    "/runtime/skills/example//SKILL.md",
    "/runtime/skills/example/SKILL.md/",
    "/runtime/skills/unselected/SKILL.md",
    "/workspace/fixture.txt",
    "/runtime/skills/example/a\0b",
    "/runtime/skills/example/" + "a/".repeat(32) + "note.txt",
  ])("rejects excluded original input %s before native operations", async (path) => {
    const { make } = await fixture();
    const reader = await make();
    const open = vi.mocked(fs.open);
    open.mockClear();
    await expect(reader.read({ path }, signal())).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    { path: selected()[0]!.path, offset: 0 },
    { path: selected()[0]!.path, limit: 1.5 },
    { path: selected()[0]!.path, limit: Number.MAX_SAFE_INTEGER + 1 },
    { path: selected()[0]!.path, extra: true },
  ])("strictly validates read arguments before native operations", async (input) => {
    const { make } = await fixture();
    const reader = await make();
    vi.mocked(fs.open).mockClear();
    await expect(reader.read(input, signal())).rejects.toThrow("INVALID_INPUT");
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("refuses a supported image using the actual SDK MIME detector", async () => {
    const { make } = await fixture({
      "SKILL.md": "Fixture",
      "assets/picture.png": Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRyoAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    const reader = await make();
    await expect(
      reader.read({ path: "/runtime/skills/example/assets/picture.png" }, signal()),
    ).rejects.toThrow("TOOL_FAILURE");
    await reader.close();
  });

  it("requires an exact readonly file mount and a matching held FD mount ID", async () => {
    const data = await fixture();
    const reader = await data.make();
    data.setTopology(data.topology().replace("/SKILL.md ro", "/SKILL.md rw"));
    await expect(reader.read({ path: selected()[0]!.path }, signal())).rejects.toThrow(
      "TOOL_FAILURE",
    );
  });

  it.each([
    (value: string) => value.replace("/note.txt ro", "/note.txt rw"),
    (value: string) => value.replace("11 1", "99 1"),
    (value: string) =>
      value
        .split("\n")
        .filter((row) => !row.includes("/note.txt "))
        .join("\n"),
    (value: string) =>
      value + "42 1 0:2 / /runtime/skills/example/assets/note.txt ro - ext4 fixture rw\n",
    (value: string) => value.replace("/ / ro", "/ / rw"),
    (value: string) => value + "51 1 0:2 / /runtime/skills/example/assets rw - ext4 fixture rw\n",
    (_value: string) => "x".repeat(65_537),
    (_value: string) =>
      Array.from(
        { length: 513 },
        (_, i) => `${i + 1} 0 0:1 / /point${i} ro - tmpfs tmpfs rw\n`,
      ).join(""),
  ])("denies changed, incomplete or oversized synthetic kernel topology", async (change) => {
    const data = await fixture();
    const reader = await data.make();
    data.setTopology(change(data.topology()));
    await expect(
      reader.read({ path: "/runtime/skills/example/assets/note.txt" }, signal()),
    ).rejects.toThrow("TOOL_FAILURE");
    await reader.close();
    expect(data.handles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it.each(
    [
      [
        {
          key: "not_a_managed_key",
          path: "/runtime/skills/not_a_managed_key/SKILL.md",
          description: "Fixture",
        },
      ],
      [{ ...selected()[0]!, path: "/runtime/skills/example/other.md" }],
      [{ ...selected()[0]!, description: "é".repeat(2001) }],
      [selected()[0]!, selected()[0]!],
      [{ ...selected()[0]!, extra: true }],
      Array.from({ length: 33 }, (_, i) => ({
        key: `example-${i}`,
        path: `/runtime/skills/example-${i}/SKILL.md`,
        description: "Fixture",
      })),
    ].map((skills) => ({ skills })),
  )(
    "rejects invalid bootstrap selection before allocating native authority",
    async ({ skills }) => {
      const open = vi.spyOn(fs, "open");
      await expect(makePiSelectedSkillRead(skills)).rejects.toThrow("INVALID_INPUT");
      expect(open).not.toHaveBeenCalled();
    },
  );

  it("closes every acquired ancestor when selected-root admission fails", async () => {
    const data = await fixture();
    const skills = [
      { key: "missing", path: "/runtime/skills/missing/SKILL.md", description: "Fixture" },
    ];
    await expect(makePiSelectedSkillRead(skills)).rejects.toThrow();
    expect(data.handles.length).toBeGreaterThan(0);
    expect(data.handles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it.each([
    ["SKILL.md", 8_000_001],
    ["t3-skill.json", 65_537],
  ] as const)(
    "refuses oversized %s before reading any native file bytes",
    async (relative, size) => {
      const data = await fixture({ "SKILL.md": "Fixture", [relative]: Buffer.alloc(size, 120) });
      const reader = await data.make();
      const original = vi.mocked(fs.open).getMockImplementation()!;
      let opened = false;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (String(args[0]).endsWith("/" + relative)) opened = true;
        return original(...args);
      });
      await expect(
        reader.read({ path: "/runtime/skills/example/" + relative }, signal()),
      ).rejects.toThrow("TOOL_FAILURE");
      expect(opened).toBe(false);
    },
  );

  it("retains actual SDK truncation details", async () => {
    const { make } = await fixture({
      "SKILL.md": Array.from({ length: 2101 }, (_, i) => "line " + i).join("\n"),
    });
    const reader = await make();
    const result = await reader.read({ path: selected()[0]!.path }, signal());
    expect(text(result)).toContain("[Showing lines 1-2000 of 2101. Use offset=2001 to continue.]");
    expect(result.details).toMatchObject({
      truncation: { truncated: true, truncatedBy: "lines", totalLines: 2101, outputLines: 2000 },
    });
  });

  it("joins a successful read and refuses overlapping allocation", async () => {
    const { make } = await fixture();
    const reader = await make();
    const first = reader.read({ path: selected()[0]!.path }, signal());
    await expect(reader.read({ path: selected()[0]!.path }, signal())).rejects.toThrow(
      "TOOL_FAILURE",
    );
    expect(text(await first)).toContain("one");
    expect(text(await reader.read({ path: selected()[0]!.path }, signal()))).toContain("one");
  });

  it("reports uncertain close while still closing every other descriptor", async () => {
    const { make, handles } = await fixture();
    const reader = await make();
    const held = handles.find((handle) => handle.fd !== -1)!;
    const close = held.close.bind(held);
    vi.spyOn(held, "close").mockImplementation(async () => {
      await close();
      throw Error("synthetic close uncertainty");
    });
    await expect(reader.close()).rejects.toThrow("TOOL_FAILURE");
    expect(handles.every((handle) => handle.fd === -1)).toBe(true);
    await expect(reader.read({ path: selected()[0]!.path }, signal())).rejects.toThrow(
      "TOOL_FAILURE",
    );
  });

  it("synchronously snapshots selected records before metadata or ancestor I/O", async () => {
    const data = await fixture();
    const skills = selected();
    const creation = makePiSelectedSkillRead(skills);
    skills[0]!.key = "changed";
    skills[0]!.path = "/runtime/skills/changed/SKILL.md";
    skills.splice(0);
    const reader = await creation;
    readers.push(reader);
    expect(text(await reader.read({ path: selected()[0]!.path }, signal()))).toContain("one");
    await reader.close();
    expect(data.handles.every((handle) => handle.fd === -1)).toBe(true);
  });

  it("closes synchronously to admission and joins descriptor work after SDK cancellation", async () => {
    const { make, handles } = await fixture();
    const reader = await make();
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const open = vi.mocked(fs.open).getMockImplementation()!;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith("/SKILL.md")) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
          const outcome = await read(...readArgs);
          entered.resolve();
          await released.promise;
          return outcome;
        });
      }
      return handle;
    });
    const controller = new AbortController();
    const outcome = reader.read({ path: selected()[0]!.path }, controller.signal).then(
      () => "unexpected",
      (error: unknown) => String(error),
    );
    await entered.promise;
    controller.abort();
    expect(await outcome).toContain("Operation aborted");
    const close = reader.close();
    expect(reader.close()).toBe(close);
    await expect(reader.read({ path: selected()[0]!.path }, signal())).rejects.toThrow(
      "TOOL_FAILURE",
    );
    expect(handles.some((handle) => handle.fd !== -1)).toBe(true);
    released.resolve();
    await close;
    expect(handles.every((handle) => handle.fd === -1)).toBe(true);
  });
});
