// @effect-diagnostics nodeBuiltinImport:off - Captured Node children prove actual SDK import, native persistence and stdio ownership.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { piLocalToolDefinitions } from "./PiLocalTools.ts";
import { decodePiWorkerLaunch, isPiWorkerNodeVersionSupported } from "./PiWorkerEntrypoint.ts";
import {
  decodePiWorkerFrame,
  encodePiParentFrame,
  makePiWorkerLineFramer,
  type PiWorkerBootstrap,
  type PiNativeReference,
  type PiParentFrame,
  type PiWorkerOperation,
} from "./PiWorkerProtocol.ts";

const decodeNativeArguments = Schema.decodeSync(Schema.JsonObject);
const decodeReceiptJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject));
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
    executable: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.NullOr(Schema.Int)),
    exitSignal: Schema.optional(Schema.NullOr(Schema.String)),
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

const decodeClosure = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      files: Schema.Array(Schema.Struct({ source: Schema.String, target: Schema.String })),
    }),
  ),
);
const decodeContainerInfo = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      "child-pid": Schema.Int,
    }),
  ),
);
const promptOperation = { operationId: "entry-native-tools", operationKind: "prompt" } as const;
type Namespace = {
  readonly workspace: string;
  readonly state: string;
  readonly files: ReturnType<typeof decodeClosure>["files"];
};
async function childFixture(
  mode: string,
  rawLaunchJson: string,
  agentDirectory: string,
  namespace?: Namespace,
) {
  const childOperation: PiWorkerOperation = namespace ? promptOperation : operation;
  const executable = namespace ? "/usr/bin/bwrap" : process.execPath;
  const args = namespace
    ? [
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--clearenv",
        "--info-fd",
        "3",
        ...namespace.files.flatMap((file) => ["--ro-bind", file.source, file.target]),
        "--bind",
        namespace.workspace,
        "/workspace",
        "--bind",
        namespace.state,
        "/state",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--setenv",
        "HOME",
        "/state/agent",
        "--setenv",
        "PATH",
        "/bin",
        "--setenv",
        "PI_CODING_AGENT_DIR",
        "/state/agent",
        "--setenv",
        "PI_PACKAGE_DIR",
        "/invalid-ambient",
        "--remount-ro",
        "/",
        "--chdir",
        "/workspace",
        "/runtime/node",
        "--max-old-space-size=128",
        "/runtime/p7-worker-entry-local-tools.mjs",
        mode,
        rawLaunchJson,
      ]
    : [
        "--max-old-space-size=128",
        new URL("./fixtures/p7-worker-entry-child.mjs", import.meta.url).pathname,
        mode,
        rawLaunchJson,
      ];
  const child = NodeChildProcess.spawn(executable, args, {
    cwd: process.cwd(),
    stdio: namespace ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "ipc"],
    env: { PATH: "", PI_CODING_AGENT_DIR: agentDirectory, PI_PACKAGE_DIR: "/invalid-ambient" },
  });
  const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  const closed = Promise.withResolvers<void>();
  child.once("exit", (code, signal) => exited.resolve({ code, signal }));
  child.once("close", () => closed.resolve());
  const messages: ReturnType<typeof decodeReceipt>[] = [];
  const observed: ReturnType<typeof decodeReceipt>[] = [];
  let next = Promise.withResolvers<void>();
  const receive = (raw: unknown) => {
    const message = decodeReceipt(raw);
    messages.push(message);
    observed.push(message);
    next.resolve();
    next = Promise.withResolvers<void>();
  };
  child.on("message", receive);
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
  const container = Promise.withResolvers<number>();
  container.promise.catch(() => {});
  if (namespace) {
    const info = child.stdio[3];
    if (!info) throw Error("CONTAINER_INFO_UNAVAILABLE");
    let infoBytes = "";
    info.on("data", (bytes: Buffer) => {
      infoBytes += bytes.toString();
    });
    info.once("end", () => {
      try {
        container.resolve(decodeContainerInfo(infoBytes)["child-pid"]);
      } catch (error) {
        container.reject(error);
      }
    });
  }
  let nativeNodeHostPid: number | undefined;
  let nextFrame = Promise.withResolvers<void>();
  let receiptBytes = "";
  let stderrBytes = Buffer.alloc(0);
  const framer = makePiWorkerLineFramer((raw) => {
    frames.push(decodePiWorkerFrame(raw));
    nextFrame.resolve();
    nextFrame = Promise.withResolvers<void>();
  });
  stdout.on("data", (bytes: Buffer) => {
    stdoutBytes += bytes.length;
    framer.push(bytes);
  });
  stderr.on("data", (bytes: Buffer) => {
    if (namespace) {
      receiptBytes += bytes.toString();
      if (Buffer.byteLength(receiptBytes) > 65_536) throw Error("FIXTURE_RECEIPT_LIMIT");
      while (receiptBytes.includes("\n")) {
        const end = receiptBytes.indexOf("\n");
        receive(decodeReceiptJson(receiptBytes.slice(0, end)));
        receiptBytes = receiptBytes.slice(end + 1);
      }
    } else stderrBytes = Buffer.concat([stderrBytes, bytes]).subarray(0, 65_536);
  });
  return {
    pid: child.pid,
    containerPid: () => container.promise,
    async captureNativeNode(namespacePid: number) {
      const ownerPid = await container.promise;
      const children = (
        await NodeFSP.readFile(`/proc/${ownerPid}/task/${ownerPid}/children`, "utf8")
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
      expect(children).toHaveLength(1);
      const pid = children[0];
      if (pid === undefined) throw Error("NATIVE_NODE_PID_UNAVAILABLE");
      const status = await NodeFSP.readFile(`/proc/${pid}/status`, "utf8");
      expect(
        status
          .match(/^NSpid:\s+(.+)$/m)?.[1]
          ?.trim()
          .split(/\s+/)
          .at(-1),
      ).toBe(String(namespacePid));
      nativeNodeHostPid = pid;
      return pid;
    },
    async waitFrame(predicate: (frame: ReturnType<typeof decodePiWorkerFrame>) => boolean) {
      while (true) {
        const frame = frames.find(predicate);
        if (frame) return frame;
        const failure = frames.find((frame) => frame.message.type === "worker-failure");
        if (failure) throw Error(`UNEXPECTED_WORKER_FAILURE: ${JSON.stringify(failure.message)}`);
        await Promise.race([
          nextFrame.promise,
          closed.promise.then(() => {
            throw Error("CHILD_CLOSED_BEFORE_FRAME");
          }),
        ]);
      }
    },
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
        ...childOperation,
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
      expect(receiptBytes).toBe("");
      framer.finish();
      // bwrap close does not reap its orphaned init on failed operations. The explicit
      // native gate requires an outer subreaper that joins and asserts every captured
      // init/Node host PID absent before reporting the capped check successful.
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
              containerPid: namespace ? await container.promise.catch(() => null) : null,
              nativeNodeHostPid,
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

async function nativeRoots() {
  const closure = process.env.PI_WORKER_ENTRY_LOCAL_TOOLS_CLOSURE;
  if (!closure) throw Error("NATIVE_ENTRY_CLOSURE_REQUIRED");
  if (!process.env.PI_WORKER_ENTRY_REAPING_OWNER_PID)
    throw Error("NATIVE_ENTRY_REAPING_OWNER_REQUIRED");
  const r = await roots();
  const workspace = NodePath.join(r.root, "workspace");
  const state = NodePath.join(r.root, "state");
  await NodeFSP.mkdir(workspace);
  await NodeFSP.mkdir(NodePath.join(state, "sessions"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(state, "agent"));
  return {
    ...r,
    workspace,
    namespace: {
      workspace,
      state,
      files: decodeClosure(await NodeFSP.readFile(closure, "utf8")).files,
    },
    launch: {
      ...r.launch,
      operation: promptOperation,
      sessionDirectory: "/state/sessions",
      trustedSdkPackageDirectory: "/runtime/pi-sdk",
    },
  };
}
async function nativeProtocol(
  f: Awaited<ReturnType<typeof childFixture>>,
  names: readonly string[],
) {
  let sequence = 0;
  const send = (message: PiParentFrame["message"]) => f.send(sequence++, message);
  const transfer = async (transferId: string, text: string) => {
    const bytes = Buffer.from(text);
    let index = 0;
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      await send({
        type: "transfer-chunk",
        transferId,
        index: index++,
        offset,
        data: bytes.subarray(offset, offset + 8192).toString("base64"),
      });
    }
    await send({ type: "transfer-end", transferId });
  };
  const selected = piLocalToolDefinitions.filter((tool) => names.includes(tool.name));
  const prompt = "Deterministic native tool fixture; no inference.";
  await send({
    ...bootstrap(),
    expectedCwd: "/workspace",
    prompt: { transferId: "prompt", totalBytes: Buffer.byteLength(prompt) },
    allowedTools: selected.map((tool) => ({
      name: tool.name,
      execution: "local",
      description: tool.description,
      inputSchema: {
        transferId: `schema-${tool.name}`,
        totalBytes: Buffer.byteLength(JSON.stringify(tool.parameters)),
      },
    })),
  });
  await transfer("context", context);
  await transfer("prompt", prompt);
  for (const tool of selected)
    await transfer(`schema-${tool.name}`, JSON.stringify(tool.parameters));
  const reply = async (
    requestId: number,
    call?: { readonly name: string; readonly args: Schema.JsonObject },
  ) => {
    await send({ type: "headers", requestId, status: 200 });
    const delta = call
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `native-call-${requestId}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        }
      : { role: "assistant", content: "Fixture complete." };
    const chunks = [
      {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "no-inference",
        choices: [{ index: 0, delta, finish_reason: null }],
      },
      {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "no-inference",
        choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];
    const data = Buffer.from(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    );
    for (let offset = 0; offset < data.length; offset += 8192) {
      const expected = sequence;
      await send({
        type: "chunk",
        requestId,
        data: data.subarray(offset, offset + 8192).toString("base64"),
      });
      await f.waitFrame(
        (frame) =>
          frame.message.type === "ack" &&
          frame.message.requestId === requestId &&
          frame.message.chunkSequence === expected,
      );
    }
    await send({ type: "end", requestId });
  };
  const request = async (requestId: number) => {
    await f.waitFrame(
      (frame) => frame.message.type === "request" && frame.message.requestId === requestId,
    );
  };
  const toolCall = async (callId: number) => {
    const frame = await f.waitFrame(
      (frame) => frame.message.type === "tool-call" && frame.message.callId === callId,
    );
    if (frame.message.type !== "tool-call") throw Error("MISSING_TOOL_CALL");
    await f.waitFrame(
      (frame) =>
        frame.message.type === "transfer-end" &&
        frame.message.transferId === `tool-input-${callId}`,
    );
    return frame.message;
  };
  return { send, reply, request, toolCall };
}
async function assertNativeInert(f: Awaited<ReturnType<typeof childFixture>>) {
  const receipt = await f.wait("imported");
  assertInert(receipt);
  if (receipt.pid === undefined) throw Error("NATIVE_NAMESPACE_PID_REQUIRED");
  await f.captureNativeNode(receipt.pid);
}
const nativeEntryEnabled = process.env.PI_WORKER_ENTRY_LOCAL_TOOLS_GATE === "1";

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
      JSON.stringify({ ...launch, cwd: "/untrusted" }),
      JSON.stringify({ ...launch, tools: ["bash"] }),
      JSON.stringify({ ...launch, runtime: { localTools: ["write"] } }),
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

  it("refuses an unavailable local tool before session creation", async () => {
    const r = await roots();
    const f = await childFixture("local-tool", JSON.stringify(r.launch), r.root);
    try {
      assertInert(await f.wait("imported"));
      await f.send(0, {
        ...bootstrap(),
        allowedTools: [
          { name: "unselected-native", execution: "local", description: "unavailable local tool" },
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

describe.skipIf(!nativeEntryEnabled)("actual bundled Pi entry in an owned namespace", () => {
  it.each(["read", "write", "edit"] as const)(
    "denies native %s access to state, runtime and file aliases",
    async (name) => {
      for (const alias of [
        "absolute-state",
        "relative-state",
        "file-url",
        "at-prefix",
        "symbolic-file",
        "symbolic-directory",
        "hardlink-state",
        "protected-git",
        "absolute-runtime",
      ]) {
        const r = await nativeRoots();
        const secret = NodePath.join(r.namespace.state, "sessions/private.txt");
        await NodeFSP.writeFile(secret, "private-original");
        await NodeFSP.writeFile(NodePath.join(r.workspace, ".git"), "protected-original");
        let path = "/state/sessions/private.txt";
        if (alias === "relative-state") path = "../state/sessions/private.txt";
        if (alias === "file-url") path = "file:///state/sessions/private.txt";
        if (alias === "at-prefix") path = "@/state/sessions/private.txt";
        if (alias === "symbolic-file") {
          path = "file-alias";
          await NodeFSP.symlink("/state/sessions/private.txt", NodePath.join(r.workspace, path));
        }
        if (alias === "symbolic-directory") {
          path = "directory-alias/private.txt";
          await NodeFSP.symlink("/state/sessions", NodePath.join(r.workspace, "directory-alias"));
        }
        if (alias === "hardlink-state") {
          path = "hard-alias";
          await NodeFSP.link(secret, NodePath.join(r.workspace, path));
        }
        if (alias === "protected-git") path = "/workspace/.git";
        if (alias === "absolute-runtime") path = "/runtime/pi-sdk/package.json";
        const f = await childFixture(
          `file-boundary-${name}-${alias}`,
          JSON.stringify(r.launch),
          r.root,
          r.namespace,
        );
        try {
          await assertNativeInert(f);
          const protocol = await nativeProtocol(f, [name]);
          await protocol.request(1);
          const args =
            name === "read"
              ? { path }
              : name === "write"
                ? { path, content: "altered" }
                : { path, edits: [{ oldText: "private-original", newText: "altered" }] };
          await protocol.reply(1, { name, args: decodeNativeArguments(args) });
          const call = await protocol.toolCall(1);
          await protocol.send({ type: "tool-authorized", callId: call.callId, allowed: true });
          const result = await f.wait("result");
          expect(result.remoteCalls).toBe(0);
          f.stdin.end();
          await f.join(1);
          expect(result.ok).toBe(false);
          expect(f.frames.at(-1)?.message).toEqual({
            type: "worker-failure",
            code: "TOOL_FAILURE",
          });
          expect(f.frames.filter((frame) => frame.message.type === "request")).toHaveLength(1);
          expect(f.frames.some((frame) => frame.message.type === "tool-result")).toBe(false);
          expect(await NodeFSP.readFile(secret, "utf8")).toBe("private-original");
          expect(await NodeFSP.readFile(NodePath.join(r.workspace, ".git"), "utf8")).toBe(
            "protected-original",
          );
          const evidence = process.env.PI_WORKER_ENTRY_EVIDENCE_DIRECTORY;
          if (evidence)
            await NodeFSP.writeFile(
              NodePath.join(evidence, `filesystem-${name}-${alias}.json`),
              JSON.stringify({
                name,
                alias,
                path,
                result,
                frames: f.frames,
                stateBytes: await NodeFSP.readFile(secret, "utf8"),
                protectedBytes: await NodeFSP.readFile(NodePath.join(r.workspace, ".git"), "utf8"),
              }),
            );
        } finally {
          await f.dispose();
          await r.dispose();
        }
      }
    },
    30000,
  );

  it("executes selected native write/read/edit/bash through parent authorization and real SDK lifecycle", async () => {
    const r = await nativeRoots();
    const f = await childFixture("selected-native", JSON.stringify(r.launch), r.root, r.namespace);
    try {
      await assertNativeInert(f);
      const p = await nativeProtocol(f, ["read", "write", "edit", "bash"]);
      const calls = [
        { name: "write", args: { path: "nested/selected.txt", content: "before" } },
        { name: "read", args: { path: "/workspace/nested/selected.txt" } },
        {
          name: "edit",
          args: {
            path: "nested/../nested/selected.txt",
            edits: [{ oldText: "before", newText: "after" }],
          },
        },
        { name: "bash", args: { command: "printf 'entry-native-bash-marker:%s' \"$PWD\"" } },
      ];
      for (const [index, call] of calls.entries()) {
        await p.request(index + 1);
        await p.reply(index + 1, {
          name: call.name,
          args: decodeNativeArguments(call.args),
        });
        const invoked = await p.toolCall(index + 1);
        expect(invoked.toolName).toBe(call.name);
        await p.send({ type: "tool-authorized", callId: invoked.callId, allowed: true });
        await f.waitFrame(
          (frame) =>
            frame.message.type === "transfer-end" &&
            frame.message.transferId === `tool-output-${invoked.callId}`,
        );
      }
      await p.request(5);
      await p.reply(5);
      const result = await f.wait("result");
      expect(result.ok).toBe(true);
      expect(result.remoteCalls).toBe(0);
      expect(result.sdkEnvironmentCorrect).toBe(true);
      f.stdin.end();
      await f.join(0);
      expect(
        await NodeFSP.readFile(NodePath.join(r.workspace, "nested/selected.txt"), "utf8"),
      ).toBe("after");
      const outputs = f.frames
        .filter(
          (frame) =>
            frame.message.type === "transfer-chunk" &&
            frame.message.transferId.startsWith("tool-output-"),
        )
        .map((frame) =>
          frame.message.type === "transfer-chunk"
            ? Buffer.from(frame.message.data, "base64").toString()
            : "",
        )
        .join("");
      expect(outputs).toContain("before");
      expect(outputs).toContain("entry-native-bash-marker:/workspace");
      expect(f.frames.at(-1)?.message).toEqual({ type: "done" });
      const spawned = await f.wait("native-spawn");
      const exited = await f.wait("native-exit");
      expect(spawned.executable).toBe("/bin/bash");
      expect(exited).toMatchObject({ pid: spawned.pid, exitCode: 0, exitSignal: null });
    } finally {
      await f.dispose();
      await r.dispose();
    }
  });

  it("does not activate an unselected native write from a deterministic completion", async () => {
    const r = await nativeRoots();
    const f = await childFixture("unselected", JSON.stringify(r.launch), r.root, r.namespace);
    try {
      await assertNativeInert(f);
      const p = await nativeProtocol(f, ["read"]);
      await p.request(1);
      await p.reply(1, {
        name: "write",
        args: { path: "unselected.txt", content: "must not write" },
      });
      const next = await f.waitFrame(
        (frame) =>
          frame.message.type === "worker-failure" ||
          (frame.message.type === "request" && frame.message.requestId === 2),
      );
      if (next.message.type === "request") await p.reply(2);
      const result = await f.wait("result");
      expect(result.remoteCalls).toBe(0);
      f.stdin.end();
      await f.join(result.ok ? 0 : 1);
      expect(await NodeFSP.readdir(r.workspace)).toEqual([]);
      expect(f.frames.some((frame) => frame.message.type === "tool-call")).toBe(false);
      expect(
        f.frames.some(
          (frame) =>
            frame.message.type === "sdk-event" && frame.message.event.type === "tool_start",
        ),
      ).toBe(false);
    } finally {
      await f.dispose();
      await r.dispose();
    }
  });

  it.each(["denied", "canceled"])(
    "does not invoke native write when authorization is %s",
    async (mode) => {
      const r = await nativeRoots();
      const f = await childFixture(mode, JSON.stringify(r.launch), r.root, r.namespace);
      try {
        await assertNativeInert(f);
        const p = await nativeProtocol(f, ["write"]);
        await p.request(1);
        await p.reply(1, {
          name: "write",
          args: { path: "forbidden.txt", content: "must not write" },
        });
        const call = await p.toolCall(1);
        if (mode === "denied")
          await p.send({ type: "tool-authorized", callId: call.callId, allowed: false });
        else {
          await p.send({ type: "interrupt", controlId: 1 });
          const receipt = await f.waitFrame((frame) => frame.message.type === "control-receipt");
          expect(receipt.message).toEqual({
            type: "control-receipt",
            kind: "interrupt",
            controlId: 1,
          });
        }
        expect((await f.wait("result")).remoteCalls).toBe(0);
        f.stdin.end();
        await f.join(1);
        expect(await NodeFSP.readdir(r.workspace)).toEqual([]);
        expect(
          f.frames.some(
            (frame) =>
              frame.message.type === "sdk-event" && frame.message.event.type === "tool_start",
          ),
        ).toBe(false);
        expect(f.frames.at(-1)?.message).toEqual({
          type: "worker-failure",
          code: mode === "denied" ? "TOOL_DENIED" : "CANCELED",
        });
      } finally {
        await f.dispose();
        await r.dispose();
      }
    },
  );

  it("retains a native edit mutation when its result exceeds bounds and makes no implicit retry", async () => {
    const r = await nativeRoots();
    await NodeFSP.writeFile(
      NodePath.join(r.workspace, "wide-line.txt"),
      "unique-token " + "a".repeat(40000) + "\n",
    );
    const f = await childFixture("uncertain-edit", JSON.stringify(r.launch), r.root, r.namespace);
    try {
      await assertNativeInert(f);
      const p = await nativeProtocol(f, ["edit"]);
      await p.request(1);
      await p.reply(1, {
        name: "edit",
        args: {
          path: "wide-line.txt",
          edits: [{ oldText: "unique-token", newText: "replacement-token" }],
        },
      });
      const call = await p.toolCall(1);
      await p.send({ type: "tool-authorized", callId: call.callId, allowed: true });
      expect((await f.wait("result")).remoteCalls).toBe(0);
      f.stdin.end();
      await f.join(1);
      expect(
        (await NodeFSP.readFile(NodePath.join(r.workspace, "wide-line.txt"), "utf8")).startsWith(
          "replacement-token ",
        ),
      ).toBe(true);
      expect(f.frames.at(-1)?.message).toEqual({ type: "worker-failure", code: "TOOL_FAILURE" });
      expect(f.frames.filter((frame) => frame.message.type === "request")).toHaveLength(1);
      expect(f.frames.filter((frame) => frame.message.type === "tool-call")).toHaveLength(1);
      expect(f.frames.some((frame) => frame.message.type === "tool-result")).toBe(false);
    } finally {
      await f.dispose();
      await r.dispose();
    }
  });
});
