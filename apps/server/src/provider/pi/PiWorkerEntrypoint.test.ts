// @effect-diagnostics nodeBuiltinImport:off - Captured Node children prove actual SDK import, native persistence and stdio ownership.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { decodePiWorkerLaunch, isPiWorkerNodeVersionSupported } from "./PiWorkerEntrypoint.ts";
import {
  decodePiWorkerFrame,
  encodePiParentFrame,
  makePiWorkerLineFramer,
  type PiWorkerBootstrap,
  type PiNativeReference,
} from "./PiWorkerProtocol.ts";

const identity = { workerId: "entry-child", generation: 1 };
const operation = { operationId: "entry-initialize", operationKind: "initialize" } as const;
const context = "Approved assignment. Preserve decision, question and limit; no inference.";
const decodeReceipt = Schema.decodeUnknownSync(
  Schema.Struct({
    type: Schema.String,
    ok: Schema.optional(Schema.Boolean),
    code: Schema.optional(Schema.String),
    repeatedCode: Schema.optional(Schema.String),
    pid: Schema.optional(Schema.Int),
    node: Schema.optional(Schema.String),
    hostImports: Schema.Int,
    sdkImports: Schema.Int,
    sdkEnvironmentCorrect: Schema.optional(Schema.Boolean),
    remoteCalls: Schema.optional(Schema.Int),
    environmentUnchanged: Schema.optional(Schema.Boolean),
    listenersUnchanged: Schema.optional(Schema.Boolean),
    readerUnchanged: Schema.optional(Schema.Boolean),
    flowUnchanged: Schema.optional(Schema.Boolean),
    inputBytes: Schema.optional(Schema.Int),
    rawInputDestroyed: Schema.optional(Schema.Boolean),
    rawOutputDestroyed: Schema.optional(Schema.Boolean),
    rawOutputEnded: Schema.optional(Schema.Boolean),
  }),
);

async function roots() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-entry-"));
  const sessionDirectory = NodePath.join(root, "sessions");
  const trustedSdkPackageDirectory = NodePath.join(root, "metadata");
  await NodeFSP.mkdir(sessionDirectory);
  await NodeFSP.mkdir(trustedSdkPackageDirectory);
  await NodeFSP.writeFile(
    NodePath.join(trustedSdkPackageDirectory, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.99.1" }),
  );
  return {
    root,
    sessionDirectory,
    trustedSdkPackageDirectory,
    launch: { identity, operation, sessionDirectory, trustedSdkPackageDirectory },
    async dispose() {
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

async function childFixture(mode: string, rawLaunchJson: string, agentDirectory: string) {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "--max-old-space-size=128",
      new URL("./fixtures/p7-worker-entry-child.mjs", import.meta.url).pathname,
      mode,
      rawLaunchJson,
    ],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: { PATH: "", PI_CODING_AGENT_DIR: agentDirectory, PI_PACKAGE_DIR: "/invalid-ambient" },
    },
  );
  const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  const closed = Promise.withResolvers<void>();
  child.once("exit", (code, signal) => exited.resolve({ code, signal }));
  child.once("close", () => closed.resolve());
  const messages: ReturnType<typeof decodeReceipt>[] = [];
  const observed: ReturnType<typeof decodeReceipt>[] = [];
  let next = Promise.withResolvers<void>();
  child.on("message", (raw) => {
    const message = decodeReceipt(raw);
    messages.push(message);
    observed.push(message);
    next.resolve();
    next = Promise.withResolvers<void>();
  });
  const spawned = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  await spawned;
  const { stdin, stdout, stderr } = child;
  if (!stdin || !stdout || !stderr) {
    child.kill("SIGKILL");
    await closed.promise;
    throw Error("CHILD_PIPE_UNAVAILABLE");
  }
  stdin.on("error", () => {});
  const frames: ReturnType<typeof decodePiWorkerFrame>[] = [];
  let stdoutBytes = 0;
  let stderrBytes = Buffer.alloc(0);
  const framer = makePiWorkerLineFramer((raw) => frames.push(decodePiWorkerFrame(raw)));
  stdout.on("data", (bytes: Buffer) => {
    stdoutBytes += bytes.length;
    framer.push(bytes);
  });
  stderr.on("data", (bytes: Buffer) => {
    stderrBytes = Buffer.concat([stderrBytes, bytes]).subarray(0, 65_536);
  });
  return {
    pid: child.pid,
    stdin,
    frames,
    async wait(type: string) {
      while (true) {
        const index = messages.findIndex((message) => message.type === type);
        if (index !== -1) return messages.splice(index, 1)[0]!;
        await Promise.race([
          next.promise,
          closed.promise.then(() => {
            throw Error(`CHILD_CLOSED_BEFORE_RECEIPT: ${stderrBytes.toString()}`);
          }),
        ]);
      }
    },
    async send(sequence: number, message: Parameters<typeof encodePiParentFrame>[0]["message"]) {
      const bytes = encodePiParentFrame({
        version: 1,
        ...identity,
        ...operation,
        sequence,
        message,
      });
      await new Promise<void>((resolve, reject) =>
        stdin.write(bytes, (error) => (error ? reject(error) : resolve())),
      );
    },
    async join(code: number) {
      await closed.promise;
      const exit = await exited.promise;
      expect(exit).toEqual({ code, signal: null });
      expect([stdin.closed, stdout.closed, stderr.closed]).toEqual([true, true, true]);
      expect(stderrBytes.toString()).toBe("");
      framer.finish();
      return exit;
    },
    stdoutBytes: () => stdoutBytes,
    async dispose() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed.promise;
      const evidence = process.env.PI_WORKER_ENTRY_EVIDENCE_DIRECTORY;
      if (evidence)
        await NodeFSP.writeFile(
          NodePath.join(evidence, `${mode}-${child.pid}.json`),
          JSON.stringify(
            {
              mode,
              pid: child.pid,
              exit: await exited.promise,
              observed,
              frames,
              stdoutBytes,
              stderr: stderrBytes.toString(),
              pipeClosed: [stdin.closed, stdout.closed, stderr.closed],
            },
            null,
            2,
          ),
        );
    },
  };
}

const bootstrap = (native: PiNativeReference | null = null): PiWorkerBootstrap => ({
  type: "bootstrap",
  executionMode: "ordinary",
  expectedCwd: process.cwd(),
  native,
  context: { transferId: "context", totalBytes: Buffer.byteLength(context) },
  prompt: null,
  model: {
    provider: "synthetic",
    modelId: "no-inference",
    api: "openai-completions",
    contextWindow: 32768,
    maxTokens: 512,
    reasoning: false,
  },
  allowedTools: [],
});
async function transfer(f: Awaited<ReturnType<typeof childFixture>>) {
  await f.send(1, {
    type: "transfer-chunk",
    transferId: "context",
    index: 0,
    offset: 0,
    data: Buffer.from(context).toString("base64"),
  });
  await f.send(2, { type: "transfer-end", transferId: "context" });
}
function assertInert(receipt: ReturnType<typeof decodeReceipt>) {
  expect(receipt.hostImports).toBe(0);
  expect(receipt.sdkImports).toBe(0);
  expect(receipt.environmentUnchanged).toBe(true);
  expect(receipt.listenersUnchanged).toBe(true);
}
function assertNoCalls(receipt: ReturnType<typeof decodeReceipt>) {
  expect(receipt.remoteCalls).toBe(0);
  expect(receipt.repeatedCode).toBe("PI_WORKER_ALREADY_ACTIVATED");
}

describe("private Pi worker entry", () => {
  it("strictly bounds launch JSON and freezes accepted identities", () => {
    const launch = {
      identity,
      operation,
      sessionDirectory: "/owned/session",
      trustedSdkPackageDirectory: "/owned/sdk",
      compactionKeepRecentTokens: 4096,
    };
    const parsed = decodePiWorkerLaunch(JSON.stringify(launch));
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.identity)).toBe(true);
    expect(Object.isFrozen(parsed.operation)).toBe(true);
    const refused = [
      undefined,
      "{secret-sentinel",
      JSON.stringify({ ...launch, sessionDirectory: "relative" }),
      JSON.stringify({ ...launch, trustedSdkPackageDirectory: "relative" }),
      JSON.stringify({ ...launch, identity: { ...identity, secret: "sentinel" } }),
      JSON.stringify({ ...launch, operation: { ...operation, prompt: "sentinel" } }),
      JSON.stringify({ ...launch, endpoint: "secret-sentinel" }),
      JSON.stringify({ ...launch, compactionKeepRecentTokens: 0 }),
      JSON.stringify({ ...launch, compactionKeepRecentTokens: 127 }),
      JSON.stringify({ ...launch, compactionKeepRecentTokens: 4097 }),
      JSON.stringify({ ...launch, compactionKeepRecentTokens: 1_000_000 }),
      JSON.stringify({ ...launch, compactionKeepRecentTokens: 1_000_001 }),
      JSON.stringify({ ...launch, compactionKeepRecentTokens: 1.5 }),
      JSON.stringify({ ...launch, sessionDirectory: "/" + "é".repeat(8192) }),
    ];
    for (const raw of refused)
      expect(() => decodePiWorkerLaunch(raw)).toThrow("PI_WORKER_INVALID_LAUNCH");
  });

  it("accepts Node 22.19 and newer without weakening the 22 minor guard", () => {
    for (const version of ["22.19.0", "22.20.9", "23.0.0", "24.21.0", "26.8.2"])
      expect(isPiWorkerNodeVersionSupported(version)).toBe(true);
    for (const version of ["22.18.9", "21.99.0", "18.20.0", "22", "22.19.0-preview"])
      expect(isPiWorkerNodeVersionSupported(version)).toBe(false);
  });

  it("imports without SDK activation, stdio changes or package environment mutation", async () => {
    const r = await roots();
    const f = await childFixture("import-only", "undefined", r.root);
    try {
      assertInert(await f.wait("imported"));
      expect((await f.wait("result")).remoteCalls).toBe(0);
      expect(f.stdoutBytes()).toBe(0);
      await f.join(0);
    } finally {
      await f.dispose();
      await r.dispose();
    }
  });

  it("refuses malformed, oversized and authority-bearing launch data before any effects", async () => {
    const r = await roots();
    try {
      for (const raw of [
        "{secret-sentinel",
        JSON.stringify({ ...r.launch, approval: "secret-sentinel" }),
        JSON.stringify({ ...r.launch, sessionDirectory: "/" + "é".repeat(8192) }),
      ]) {
        const f = await childFixture("invalid-launch", raw, r.root);
        try {
          assertInert(await f.wait("imported"));
          const result = await f.wait("result");
          expect(result.code).toBe("PI_WORKER_INVALID_LAUNCH");
          assertInert(result);
          assertNoCalls(result);
          expect(f.stdoutBytes()).toBe(0);
          await f.join(1);
        } finally {
          await f.dispose();
        }
      }
      expect(await NodeFSP.readdir(r.sessionDirectory)).toEqual([]);
      expect((await NodeFSP.readdir(r.root)).sort()).toEqual(["metadata", "sessions"]);
    } finally {
      await r.dispose();
    }
  });

  it("refuses unsupported native retention before SDK import or stdio admission", async () => {
    const r = await roots();
    const results: ReturnType<typeof decodeReceipt>[] = [];
    try {
      for (const compactionKeepRecentTokens of [127, 4097, 1_000_000]) {
        const f = await childFixture(
          "invalid-retention",
          JSON.stringify({ ...r.launch, compactionKeepRecentTokens }),
          r.root,
        );
        try {
          // Queue valid protocol transfers before the child imports its entry. The
          // old guard reaches the SDK's narrower retention check after bootstrap;
          // the repaired guard leaves these bytes unread in the borrowed pipe.
          await f.send(0, bootstrap());
          await transfer(f);
          assertInert(await f.wait("imported"));
          const result = await f.wait("result");
          f.stdin.end();
          await f.join(1);
          results.push(result);
          if (result.code === "PI_WORKER_INVALID_LAUNCH") expect(f.stdoutBytes()).toBe(0);
          expect(await NodeFSP.readdir(r.sessionDirectory)).toEqual([]);
        } finally {
          await f.dispose();
        }
      }
      for (const result of results) {
        expect(result.code).toBe("PI_WORKER_INVALID_LAUNCH");
        assertInert(result);
        assertNoCalls(result);
        expect(result.flowUnchanged).toBe(true);
        expect(result.inputBytes).toBe(0);
        expect(result.rawInputDestroyed).toBe(false);
        expect(result.rawOutputDestroyed).toBe(false);
        expect(result.rawOutputEnded).toBe(false);
      }
      expect(results.length).toBe(3);
      expect((await NodeFSP.readdir(r.root)).sort()).toEqual(["metadata", "sessions"]);
    } finally {
      await r.dispose();
    }
  });

  it("refuses unavailable, wrong-pin, malformed, nonregular and oversized SDK metadata", async () => {
    const r = await roots();
    const metadata = NodePath.join(r.trustedSdkPackageDirectory, "package.json");
    try {
      const cases = [
        "missing",
        "wrong-name",
        "wrong-version",
        "malformed",
        "oversized",
        "directory",
        "symlink",
      ];
      for (const kind of cases) {
        await NodeFSP.rm(metadata, { recursive: true, force: true });
        if (kind === "directory") await NodeFSP.mkdir(metadata);
        else if (kind === "symlink") {
          const target = NodePath.join(r.root, "owned-metadata.json");
          await NodeFSP.writeFile(
            target,
            JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.99.1" }),
          );
          await NodeFSP.symlink(target, metadata);
        } else if (kind !== "missing") {
          await NodeFSP.writeFile(
            metadata,
            kind === "malformed"
              ? "{secret-sentinel"
              : kind === "oversized"
                ? " ".repeat(65_537)
                : JSON.stringify({
                    name:
                      kind === "wrong-name" ? "secret-sentinel" : "@earendil-works/pi-coding-agent",
                    version: kind === "wrong-version" ? "0.99.2" : "0.99.1",
                  }),
          );
        }
        const f = await childFixture(`metadata-${kind}`, JSON.stringify(r.launch), r.root);
        try {
          assertInert(await f.wait("imported"));
          const result = await f.wait("result");
          expect(result.code).toBe("PI_WORKER_INVALID_SDK_METADATA");
          assertInert(result);
          assertNoCalls(result);
          expect(f.stdoutBytes()).toBe(0);
          await f.join(1);
        } finally {
          await f.dispose();
        }
      }
      expect(await NodeFSP.readdir(r.sessionDirectory)).toEqual([]);
    } finally {
      await r.dispose();
    }
  });

  it("refuses a passive actual stdin reader without consuming bytes or activating the SDK", async () => {
    const r = await roots();
    const f = await childFixture("readable-admission", JSON.stringify(r.launch), r.root);
    try {
      assertInert(await f.wait("imported"));
      const result = await f.wait("result");
      expect(result.code).toBe("PI_WORKER_STDIO_UNAVAILABLE");
      assertInert(result);
      assertNoCalls(result);
      expect(result.readerUnchanged).toBe(true);
      expect(result.flowUnchanged).toBe(true);
      expect(result.inputBytes).toBe(0);
      expect(result.rawInputDestroyed).toBe(false);
      expect(result.rawOutputDestroyed).toBe(false);
      expect(result.rawOutputEnded).toBe(false);
      expect(f.stdoutBytes()).toBe(0);
      f.stdin.end();
      await f.join(1);
      expect(await NodeFSP.readdir(r.sessionDirectory)).toEqual([]);
    } finally {
      await f.dispose();
      await r.dispose();
    }
  });

  it("initializes, persists and reopens the same actual SDK session with zero network calls", async () => {
    const r = await roots();
    let native: PiNativeReference | null = null;
    try {
      for (const compactionKeepRecentTokens of [128, 4096]) {
        const f = await childFixture(
          "initialize",
          JSON.stringify({ ...r.launch, compactionKeepRecentTokens }),
          r.root,
        );
        try {
          assertInert(await f.wait("imported"));
          await f.send(0, bootstrap(native));
          await transfer(f);
          const result = await f.wait("result");
          expect(result.ok).toBe(true);
          expect(result.hostImports).toBe(1);
          expect(result.sdkImports).toBe(1);
          expect(result.sdkEnvironmentCorrect).toBe(true);
          expect(result.rawInputDestroyed).toBe(false);
          expect(result.rawOutputDestroyed).toBe(false);
          expect(result.rawOutputEnded).toBe(false);
          expect(result.listenersUnchanged).toBe(true);
          assertNoCalls(result);
          f.stdin.end();
          await f.join(0);
          expect(f.frames.map((frame) => frame.message.type)).toEqual(["ready", "initialized"]);
          expect(f.frames.map((frame) => frame.sequence)).toEqual([0, 1]);
          const ready = f.frames[0]?.message;
          const initialized = f.frames[1]?.message;
          if (ready?.type !== "ready" || initialized?.type !== "initialized")
            throw Error("MISSING_NATIVE_RECEIPT");
          expect(ready.actualCwd).toBe(process.cwd());
          if (native) {
            expect(ready.native).toEqual(native);
            expect(initialized.native.sessionId).toBe(native.sessionId);
            expect(initialized.native.sessionReference).toBe(native.sessionReference);
          }
          native = initialized.native;
          expect(native.persisted).toBe(true);
          const session = await NodeFSP.readFile(
            NodePath.join(r.sessionDirectory, native.sessionReference.slice(9)),
            "utf8",
          );
          const evidence = process.env.PI_WORKER_ENTRY_EVIDENCE_DIRECTORY;
          if (evidence)
            await NodeFSP.writeFile(NodePath.join(evidence, `native-${f.pid}.jsonl`), session);
          expect(session).toContain(context);
          expect(session).toContain(native.sessionId);
          expect((await NodeFSP.readdir(r.sessionDirectory)).length).toBe(1);
        } finally {
          await f.dispose();
        }
      }
    } finally {
      await r.dispose();
    }
  });

  it("joins actual SDK bootstrap cancellation and EOF without creating native files", async () => {
    const r = await roots();
    try {
      for (const mode of ["interrupt", "eof"]) {
        const f = await childFixture(mode, JSON.stringify(r.launch), r.root);
        try {
          assertInert(await f.wait("imported"));
          await f.send(0, bootstrap());
          if (mode === "interrupt") await f.send(1, { type: "interrupt", controlId: 1 });
          else f.stdin.end();
          const result = await f.wait("result");
          expect(result.code).toBe("PI_WORKER_OPERATION_FAILED");
          expect(result.hostImports).toBe(1);
          expect(result.sdkImports).toBe(1);
          expect(result.sdkEnvironmentCorrect).toBe(true);
          expect(result.rawOutputDestroyed).toBe(false);
          expect(result.rawOutputEnded).toBe(false);
          assertNoCalls(result);
          if (mode === "interrupt") {
            expect(f.frames.map((frame) => frame.message.type)).toEqual([
              "control-receipt",
              "worker-failure",
            ]);
            f.stdin.end();
          }
          await f.join(1);
          expect(await NodeFSP.readdir(r.sessionDirectory)).toEqual([]);
        } finally {
          await f.dispose();
        }
      }
    } finally {
      await r.dispose();
    }
  });

  it("refuses an implicit local tool before session creation", async () => {
    const r = await roots();
    const f = await childFixture("local-tool", JSON.stringify(r.launch), r.root);
    try {
      assertInert(await f.wait("imported"));
      await f.send(0, {
        ...bootstrap(),
        allowedTools: [
          { name: "bash", execution: "local", description: "implicit local tool refused" },
        ],
      });
      await transfer(f);
      const result = await f.wait("result");
      expect(result.code).toBe("PI_WORKER_OPERATION_FAILED");
      assertNoCalls(result);
      expect(f.frames.some((frame) => frame.message.type === "initialized")).toBe(false);
      const failure = f.frames.at(-1)?.message;
      expect(failure).toEqual({ type: "worker-failure", code: "UNAVAILABLE" });
      f.stdin.end();
      await f.join(1);
      expect(await NodeFSP.readdir(r.sessionDirectory)).toEqual([]);
    } finally {
      await f.dispose();
      await r.dispose();
    }
  });
});
