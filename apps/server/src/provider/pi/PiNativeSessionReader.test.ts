// @effect-diagnostics nodeBuiltinImport:off - Actual pinned SDK journals and captured filesystem handles are the reader's boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SessionManager, CURRENT_SESSION_VERSION, VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readPiNativeSession } from "./PiNativeSessionReader.ts";

// These spies forward real filesystem calls; only receipt timing is controlled.
vi.mock("node:fs/promises", { spy: true });
const actualFSP = await vi.importActual<typeof NodeFSP>("node:fs/promises");

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-native-reader-"));
  roots.push(root);
  const sessionDirectoryRoot = NodePath.join(root, "native");
  const expectedCwd = NodePath.join(root, "workspace");
  await NodeFSP.mkdir(expectedCwd);
  const manager = SessionManager.create(expectedCwd, sessionDirectoryRoot);
  manager.appendModelChange("synthetic", "fixture-only");
  const promptId = manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Synthetic assignment; no inference." }],
    timestamp: 1,
  });
  const leafId = manager.appendCustomEntry("reader-fixture", { retained: [1, true, null] });
  const file = manager.getSessionFile();
  if (!file) throw Error("SDK fixture did not persist");
  const input = {
    sessionDirectoryRoot,
    expectedCwd,
    native: {
      sessionId: manager.getSessionId(),
      sessionReference: `sessions/${NodePath.basename(file)}`,
      leafId,
      persisted: true,
    },
  };
  return { root, manager, file, input, promptId, leafId };
}

describe.runIf(HostProcessPlatform.defaultValue() === "linux")(
  "Pi native session read-only bytes",
  () => {
    it("reads an actual pinned SDK journal without changing bytes or mtime", async () => {
      const f = await fixture();
      const before = await NodeFSP.readFile(f.file);
      const stat = await NodeFSP.stat(f.file, { bigint: true });
      const result = await readPiNativeSession(f.input);
      expect(VERSION).toBe("0.99.1");
      expect(CURRENT_SESSION_VERSION).toBe(3);
      expect(result).toMatchObject({
        header: {
          type: "session",
          version: 3,
          id: f.input.native.sessionId,
          cwd: f.input.expectedCwd,
        },
        byteCount: before.length,
        contentSHA256: NodeCrypto.createHash("sha256").update(before).digest("hex"),
      });
      expect(result.entries.map((entry) => entry.id)).toEqual(
        f.manager.getEntries().map((entry) => entry.id),
      );
      expect(result.selectedBranch.map((entry) => entry.id)).toEqual(
        f.manager.getBranch().map((entry) => entry.id),
      );
      expect(result.entries.at(-1)?.payload).toMatchObject({
        customType: "reader-fixture",
        data: { retained: [1, true, null] },
      });
      expect(await NodeFSP.readFile(f.file)).toEqual(before);
      expect((await NodeFSP.stat(f.file, { bigint: true })).mtimeNs).toBe(stat.mtimeNs);
    });

    it("selects the exact committed branch across SDK reopen and later appends", async () => {
      const f = await fixture();
      f.manager.branch(f.promptId);
      const sibling = f.manager.appendCustomMessageEntry("sibling", "Sibling context", false);
      const earlier = await readPiNativeSession(f.input);
      expect(earlier.selectedBranch.map((entry) => entry.id)).toContain(f.leafId);
      expect(earlier.selectedBranch.map((entry) => entry.id)).not.toContain(sibling);
      const reopened = SessionManager.open(f.file, f.input.sessionDirectoryRoot);
      expect(reopened.getSessionId()).toBe(f.input.native.sessionId);
      expect(reopened.getLeafId()).toBe(sibling);
      const edit = reopened.appendContextEdit(f.promptId, {
        content: "Edited synthetic assignment",
      });
      const compact = reopened.appendCompaction("Synthetic retained context", f.promptId, 12);
      const selected = await readPiNativeSession({
        ...f.input,
        native: { ...f.input.native, leafId: compact },
      });
      expect(selected.selectedBranch.map((entry) => entry.id)).toEqual(
        reopened.getBranch(compact).map((entry) => entry.id),
      );
      expect(selected.entries.map((entry) => entry.id)).toContain(f.leafId);
      expect(selected.selectedBranch.map((entry) => entry.id)).not.toContain(f.leafId);
      expect(selected.selectedBranch.map((entry) => entry.id)).toContain(edit);
      expect(selected.entries.at(-1)?.payload).toMatchObject({
        summary: "Synthetic retained context",
        firstKeptEntryId: f.promptId,
      });
      expect((await readPiNativeSession(f.input)).selectedBranch.map((entry) => entry.id)).toEqual(
        earlier.selectedBranch.map((entry) => entry.id),
      );
    });

    it.each([undefined, 1, 2, 4])(
      "rejects unsupported version %s without SDK migration or rewrite",
      async (version) => {
        const f = await fixture();
        const header = f.manager.getHeader();
        const bytes = Buffer.from(
          [
            JSON.stringify({ ...header, version }),
            ...f.manager.getEntries().map((entry) => JSON.stringify(entry)),
          ].join("\n") + "\n",
        );
        await NodeFSP.writeFile(f.file, bytes);
        const before = await NodeFSP.stat(f.file, { bigint: true });
        await expect(readPiNativeSession(f.input)).rejects.toMatchObject({
          _tag: "PiNativeSessionReadError",
          code: "unsupported",
        });
        expect(await NodeFSP.readFile(f.file)).toEqual(bytes);
        expect((await NodeFSP.stat(f.file, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
      },
    );

    it.each([
      ["cwd", { cwd: "/different-workspace" }],
      ["session", { id: "other-session" }],
      ["timestamp", { timestamp: "invalid-time" }],
      ["type", { type: "other-header" }],
    ])("rejects mismatched header %s", async (_name, change) => {
      const f = await fixture();
      await NodeFSP.writeFile(
        f.file,
        [
          JSON.stringify({ ...f.manager.getHeader(), ...change }),
          ...f.manager.getEntries().map((entry) => JSON.stringify(entry)),
        ].join("\n") + "\n",
      );
      await expect(readPiNativeSession(f.input)).rejects.toMatchObject({
        _tag: "PiNativeSessionReadError",
      });
    });

    it.each([
      "duplicate",
      "cycle",
      "missing-parent",
      "unsupported-type",
      "invalid-id",
      "invalid-timestamp",
      "second-header",
    ])("rejects corrupt %s even on an unselected branch", async (kind) => {
      const f = await fixture();
      const extra = {
        type: "custom",
        id: "foreign",
        parentId: f.promptId,
        timestamp: "2026-10-01T00:00:00.000Z",
        customType: "fixture",
      };
      if (kind === "duplicate") extra.id = f.promptId;
      if (kind === "cycle") extra.parentId = extra.id;
      if (kind === "missing-parent") extra.parentId = "missing";
      if (kind === "unsupported-type") extra.type = "future-kind";
      if (kind === "invalid-id") extra.id = "invalid/id";
      if (kind === "invalid-timestamp") extra.timestamp = "wrong";
      if (kind === "second-header") extra.type = "session";
      await NodeFSP.appendFile(f.file, JSON.stringify(extra) + "\n");
      await expect(readPiNativeSession(f.input)).rejects.toMatchObject({
        _tag: "PiNativeSessionReadError",
      });
    });

    it("rejects multi-entry cycles and forward parents", async () => {
      const f = await fixture();
      const entry = {
        type: "custom",
        timestamp: "2026-10-01T00:00:00.000Z",
        customType: "fixture",
      };
      await NodeFSP.appendFile(
        f.file,
        JSON.stringify({ ...entry, id: "cycle-a", parentId: "cycle-b" }) +
          "\n" +
          JSON.stringify({ ...entry, id: "cycle-b", parentId: "cycle-a" }) +
          "\n",
      );
      await expect(readPiNativeSession(f.input)).rejects.toMatchObject({ code: "invalid" });
    });

    it("rejects absent, null or unpersisted committed leaf selections", async () => {
      const f = await fixture();
      for (const native of [
        { ...f.input.native, leafId: "missing" },
        { ...f.input.native, leafId: null },
        { ...f.input.native, persisted: false },
      ]) {
        await expect(readPiNativeSession({ ...f.input, native })).rejects.toMatchObject({
          _tag: "PiNativeSessionReadError",
        });
      }
    });

    it.each([
      "empty",
      "header-only",
      "missing-header",
      "malformed",
      "utf8",
      "partial",
      "blank-line",
      "deep-json",
    ])("rejects incomplete or invalid %s bytes", async (kind) => {
      const f = await fixture();
      const before = await NodeFSP.readFile(f.file);
      if (kind === "empty") await NodeFSP.writeFile(f.file, "");
      if (kind === "header-only")
        await NodeFSP.writeFile(f.file, JSON.stringify(f.manager.getHeader()) + "\n");
      if (kind === "missing-header")
        await NodeFSP.writeFile(f.file, before.subarray(before.indexOf(10) + 1));
      if (kind === "malformed") await NodeFSP.appendFile(f.file, "{bad-secret\n");
      if (kind === "utf8") await NodeFSP.appendFile(f.file, Buffer.from([0xc3, 0x28, 10]));
      if (kind === "partial") await NodeFSP.writeFile(f.file, before.subarray(0, -1));
      if (kind === "blank-line") await NodeFSP.appendFile(f.file, "\n");
      if (kind === "deep-json")
        await NodeFSP.appendFile(f.file, "[".repeat(65) + "0" + "]".repeat(65) + "\n");
      await expect(readPiNativeSession(f.input)).rejects.toMatchObject({
        _tag: "PiNativeSessionReadError",
      });
    });

    it("rejects journals over 4 MiB or 10,000 entries", async () => {
      const f = await fixture();
      const before = await NodeFSP.readFile(f.file);
      await NodeFSP.appendFile(f.file, Buffer.alloc(4 * 1024 * 1024, 32));
      await expect(readPiNativeSession(f.input)).rejects.toMatchObject({ code: "oversize" });
      const rows = Array.from({ length: 10_001 }, (_, index) =>
        JSON.stringify({
          type: "session_info",
          id: `extra-${index}`,
          parentId: null,
          timestamp: "2026-10-01T00:00:00.000Z",
        }),
      );
      await NodeFSP.writeFile(f.file, Buffer.concat([before, Buffer.from(rows.join("\n") + "\n")]));
      await expect(readPiNativeSession(f.input)).rejects.toMatchObject({ code: "oversize" });
    });

    it.each([
      "../sibling.jsonl",
      "sessions/../sibling.jsonl",
      "/absolute.jsonl",
      "other/native.jsonl",
      "sessions/sub/native.jsonl",
      "sessions/one.json",
      "sessions/one.jsonl\0",
    ])("rejects foreign reference %s before reading", async (sessionReference) => {
      const f = await fixture();
      const open = vi.spyOn(NodeFSP, "open");
      await expect(
        readPiNativeSession({ ...f.input, native: { ...f.input.native, sessionReference } }),
      ).rejects.toMatchObject({ code: "invalid" });
      expect(open).not.toHaveBeenCalled();
    });

    it("rejects symlink files, root and root ancestors before foreign bytes are read", async () => {
      const f = await fixture();
      const original = await NodeFSP.readFile(f.file);
      const foreign = NodePath.join(f.root, "foreign.jsonl");
      await NodeFSP.writeFile(foreign, original);
      await NodeFSP.unlink(f.file);
      await NodeFSP.symlink(foreign, f.file);
      await expect(readPiNativeSession(f.input)).rejects.toMatchObject({
        _tag: "PiNativeSessionReadError",
      });
      const alias = NodePath.join(f.root, "alias");
      await NodeFSP.symlink(f.input.sessionDirectoryRoot, alias);
      await expect(
        readPiNativeSession({ ...f.input, sessionDirectoryRoot: alias }),
      ).rejects.toMatchObject({ _tag: "PiNativeSessionReadError" });
      const ancestorAlias = NodePath.join(f.root, "ancestor");
      await NodeFSP.symlink(f.root, ancestorAlias);
      await expect(
        readPiNativeSession({
          ...f.input,
          sessionDirectoryRoot: NodePath.join(ancestorAlias, "native"),
        }),
      ).rejects.toMatchObject({ _tag: "PiNativeSessionReadError" });
      expect(await NodeFSP.readFile(foreign)).toEqual(original);
    });

    it("rejects nonregular and multiply-linked files", async () => {
      const f = await fixture();
      await NodeFSP.link(f.file, NodePath.join(f.root, "foreign-hardlink"));
      await expect(readPiNativeSession(f.input)).rejects.toMatchObject({ code: "invalid" });
      await NodeFSP.unlink(NodePath.join(f.root, "foreign-hardlink"));
      await NodeFSP.unlink(f.file);
      await NodeFSP.mkdir(f.file);
      await expect(readPiNativeSession(f.input)).rejects.toMatchObject({ code: "invalid" });
    });

    it("closes every captured descriptor on success and each malformed-file rejection", async () => {
      const f = await fixture();
      const realOpen = actualFSP.open;
      const handles: NodeFSP.FileHandle[] = [];
      vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        handles.push(handle);
        return handle;
      });
      await readPiNativeSession(f.input);
      await NodeFSP.appendFile(f.file, "broken\n");
      for (let index = 0; index < 3; index++)
        await expect(readPiNativeSession(f.input)).rejects.toMatchObject({
          _tag: "PiNativeSessionReadError",
        });
      expect(handles.length).toBeGreaterThan(0);
      for (const handle of handles) expect(handle.fd).toBe(-1);
    });

    it("attempts every descriptor close and does not report success after a close error", async () => {
      const f = await fixture();
      const realOpen = actualFSP.open;
      const handles: NodeFSP.FileHandle[] = [];
      vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        if (handles.length === 0) {
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementation(async () => {
            await close();
            throw Error("synthetic-close-error");
          });
        }
        handles.push(handle);
        return handle;
      });
      await expect(readPiNativeSession(f.input)).rejects.toMatchObject({ code: "unavailable" });
      for (const handle of handles) expect(handle.fd).toBe(-1);
    });

    it.each(["append", "rewrite", "grow"])(
      "rejects an observed %s during captured reads",
      async (kind) => {
        const f = await fixture();
        const realOpen = actualFSP.open;
        const original = await NodeFSP.readFile(f.file);
        let mutated = false;
        let actualBytes = 0;
        const handles: NodeFSP.FileHandle[] = [];
        vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
          const handle = await realOpen(...args);
          handles.push(handle);
          if (String(args[0]).endsWith(NodePath.basename(f.file))) {
            const read = handle.read.bind(handle);
            vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
              const result = await read(...readArgs);
              actualBytes += result.bytesRead;
              if (!mutated) {
                mutated = true;
                if (kind === "append") await NodeFSP.appendFile(f.file, "new partial append");
                if (kind === "rewrite")
                  await NodeFSP.writeFile(
                    f.file,
                    Buffer.from(original.toString().replace("retained", "modified")),
                  );
                if (kind === "grow")
                  await NodeFSP.appendFile(f.file, Buffer.alloc(5 * 1024 * 1024, 32));
              }
              return result;
            });
          }
          return handle;
        });
        await expect(readPiNativeSession(f.input)).rejects.toMatchObject({
          code: kind === "grow" ? "oversize" : "changed",
        });
        expect(mutated).toBe(true);
        expect(actualBytes).toBeLessThanOrEqual(4 * 1024 * 1024 + 1);
        for (const handle of handles) expect(handle.fd).toBe(-1);
      },
    );

    it("compares the second FD pass against the captured first bytes", async () => {
      const f = await fixture();
      const original = await NodeFSP.readFile(f.file);
      const realOpen = actualFSP.open;
      let passes = 0;
      vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        if (String(args[0]).endsWith(NodePath.basename(f.file))) {
          const read = handle.read.bind(handle);
          vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
            const result = await read(...readArgs);
            // The first read followed by EOF is one full pass on this small file.
            // Mutate immediately before the next actual read, not on a timer.
            if (++passes === 3) {
              await NodeFSP.writeFile(
                f.file,
                Buffer.from(original.toString().replace("retained", "modified")),
              );
              return read(...readArgs);
            }
            return result;
          });
        }
        return handle;
      });
      await expect(readPiNativeSession(f.input)).rejects.toMatchObject({ code: "changed" });
      expect(passes).toBe(3);
    });

    it.each(["root", "file"])(
      "rejects a symlink swap of the captured %s before native reads",
      async (kind) => {
        const f = await fixture();
        const foreign = NodePath.join(f.root, "foreign");
        await NodeFSP.mkdir(foreign);
        const secretFile = NodePath.join(foreign, NodePath.basename(f.file));
        await NodeFSP.writeFile(secretFile, "synthetic-foreign-secret");
        const realOpen = actualFSP.open;
        const handles: NodeFSP.FileHandle[] = [];
        let reads = 0;
        let swapped = false;
        vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
          const handle = await realOpen(...args);
          handles.push(handle);
          vi.spyOn(handle, "read").mockImplementation(() => {
            reads++;
            return Promise.reject(Error("Native read must not occur after the swap"));
          });
          const target = String(args[0]);
          if (
            !swapped &&
            ((kind === "root" && target.endsWith("/native")) ||
              (kind === "file" && target.endsWith(NodePath.basename(f.file))))
          ) {
            swapped = true;
            if (kind === "root") {
              await NodeFSP.rename(
                f.input.sessionDirectoryRoot,
                NodePath.join(f.root, "captured-native"),
              );
              await NodeFSP.symlink(foreign, f.input.sessionDirectoryRoot);
            } else {
              await NodeFSP.rename(f.file, `${f.file}.captured`);
              await NodeFSP.symlink(secretFile, f.file);
            }
          }
          return handle;
        });
        await expect(readPiNativeSession(f.input)).rejects.toMatchObject({ code: "changed" });
        expect(swapped).toBe(true);
        expect(reads).toBe(0);
        for (const handle of handles) expect(handle.fd).toBe(-1);
        expect(await NodeFSP.readFile(secretFile, "utf8")).toBe("synthetic-foreign-secret");
      },
    );

    it("does not change branch ancestry when opaque strings contain escaped brackets", async () => {
      const f = await fixture();
      const leafId = f.manager.appendCustomEntry("quoted", {
        text: '[[[\\\" braces { [ ] }',
        details: { retained: true },
      });
      const result = await readPiNativeSession({
        ...f.input,
        native: { ...f.input.native, leafId },
      });
      expect(result.selectedBranch.at(-1)?.payload).toMatchObject({
        customType: "quoted",
        data: { details: { retained: true } },
      });
    });

    it("sanitizes filesystem and parser failures without retaining secret bytes or paths", async () => {
      const f = await fixture();
      await NodeFSP.appendFile(f.file, "synthetic-secret-value\n");
      const failure = await readPiNativeSession(f.input).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        _tag: "PiNativeSessionReadError",
        stack: "Native Pi session read failed (invalid).",
      });
      const rendered = String(failure) + JSON.stringify(failure);
      expect(rendered).not.toContain(f.root);
      expect(rendered).not.toContain("synthetic-secret-value");
      await NodeFSP.unlink(f.file);
      const missing = await readPiNativeSession(f.input).catch((error: unknown) => error);
      expect(String(missing) + JSON.stringify(missing)).not.toContain(f.root);
      expect(missing).toMatchObject({ code: "unavailable" });
    });
  },
);

it("reports unavailable on hosts without the proven Linux descriptor boundary", async () => {
  vi.spyOn(HostProcessPlatform, "defaultValue").mockReturnValue("darwin");
  const open = vi.spyOn(NodeFSP, "open");
  await expect(
    readPiNativeSession({
      sessionDirectoryRoot: "/unused",
      expectedCwd: "/unused",
      native: {
        sessionId: "unused",
        sessionReference: "sessions/unused.jsonl",
        leafId: "unused",
        persisted: true,
      },
    }),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(open).not.toHaveBeenCalled();
});
