import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import {
  makePiWorkerLineFramer,
  makePiWorkerProtocol,
  encodePiParentFrame,
  decodePiWorkerFrame,
} from "../PiWorkerProtocol.ts";

const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-p7-sdk-worker-"));
const sessions = NodePath.join(scratch, "sessions");
await NodeFSP.mkdir(sessions);
await NodeFSP.mkdir(NodePath.join(scratch, ".pi/extensions"), { recursive: true });
await NodeFSP.writeFile(
  NodePath.join(scratch, ".pi/extensions/ambient.mjs"),
  'throw Error("AMBIENT_EXTENSION_LOADED")',
);
await NodeFSP.writeFile(NodePath.join(scratch, "AGENTS.md"), "AMBIENT_CONTEXT_SENTINEL");
const evidence = [];
async function operation(kind, native = null, scenario = "normal") {
  const identity = { workerId: "actual-sdk-worker", generation: 1 };
  const op = { operationId: `actual-${kind}`, operationKind: kind };
  const protocol = makePiWorkerProtocol(identity, op);
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      NodeURL.fileURLToPath(new URL("./p7-sdk-worker-child.mjs", import.meta.url)),
      kind,
      sessions,
      scenario,
    ],
    {
      cwd: scratch,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: scratch,
        OPENAI_API_KEY: "AMBIENT_AUTH_SENTINEL",
        NODE_OPTIONS: "--max-old-space-size=512",
      },
    },
  );
  const exited = Promise.withResolvers();
  child.once("error", exited.reject);
  let exitReceipt;
  child.once("exit", (code, signal) => {
    exitReceipt = { code, signal };
  });
  child.once("close", (code, signal) => {
    NodeAssert.deepEqual(exitReceipt, { code, signal });
    exited.resolve({ code, signal });
  });
  let stderr = "";
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  const frames = [];
  const requests = [];
  const output = [];
  let response;
  let heldEnd;
  let controlSent = false;
  let sequence = 0;
  const send = (message) => {
    const frame = { version: 1, ...identity, ...op, sequence: sequence++, message };
    protocol.acceptParent(frame);
    child.stdin.write(encodePiParentFrame(frame));
  };
  const framer = makePiWorkerLineFramer((raw) => {
    const frame = decodePiWorkerFrame(raw);
    protocol.acceptWorker(frame);
    frames.push(frame.message);
    const message = frame.message;
    if (message.type === "request") {
      const body = JSON.parse(message.body);
      NodeAssert.equal(body.model, "deterministic");
      NodeAssert.ok(!message.body.includes("AMBIENT_CONTEXT_SENTINEL"));
      requests.push(body);
      if (!controlSent && ["steer", "follow-up", "interrupt"].includes(scenario)) {
        controlSent = true;
        send(
          scenario === "interrupt"
            ? { type: "interrupt", controlId: 1 }
            : {
                type: "control",
                controlId: 1,
                kind: scenario,
                text: `${scenario} bounded fact Beta.`,
              },
        );
        if (scenario === "interrupt") return;
      }
      const chunk = (delta, finish_reason = null, usage) => ({
        id: "native-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "deterministic",
        choices: [{ index: 0, delta, finish_reason }],
        ...(usage ? { usage } : {}),
      });
      const contents =
        kind === "prompt" && requests.length === 1
          ? [
              chunk({
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: { name: "echo_assignment", arguments: '{"text":"bounded echo"}' },
                  },
                ],
              }),
              chunk({}, "tool_calls"),
            ]
          : [
              chunk({
                role: "assistant",
                content: kind === "compact" ? "Native summary." : "Assignment echoed.",
              }),
              chunk({}, "stop"),
            ];
      if (scenario === "unsafe-native-id" && requests.length === 1)
        contents[0].choices[0].delta.tool_calls[0].id = "call:unsafe";
      contents.push({
        id: "native-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "deterministic",
        choices: [],
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      });
      response = {
        id: message.requestId,
        bytes: Buffer.from(
          contents.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n",
        ),
        offset: 0,
      };
      send({ type: "headers", requestId: response.id, status: 200 });
      pushChunk();
    } else if (message.type === "ack") pushChunk();
    else if (message.type === "transfer-end" && message.transferId.startsWith("tool-input-")) {
      const input = protocol.takeTransfer(message.transferId);
      NodeAssert.deepEqual(input, {
        purpose: "tool-input",
        value: { arguments: { text: "bounded echo" } },
      });
      send({ type: "tool-authorized", callId: 1, allowed: scenario !== "tool-denied" });
    } else if (message.type === "transfer-end" && message.transferId.startsWith("tool-output-")) {
      output.push(protocol.takeTransfer(message.transferId));
    } else if (
      message.type === "sdk-event" &&
      message.event.type === "tool_start" &&
      scenario === "bridge"
    ) {
      const text = JSON.stringify({ kind: "text", text: "bounded echo" });
      send({
        type: "tool-result",
        callId: 1,
        output: { transferId: "bridged-output", totalBytes: Buffer.byteLength(text) },
      });
      send({
        type: "transfer-chunk",
        transferId: "bridged-output",
        index: 0,
        offset: 0,
        data: Buffer.from(text).toString("base64"),
      });
      send({ type: "transfer-end", transferId: "bridged-output" });
      output.push(protocol.takeTransfer("bridged-output"));
    } else if (message.type === "agent_settled" && heldEnd) {
      NodeAssert.ok(!frames.some((f) => f.type === "done" || f.type === "native"));
      if (scenario === "persistence-loss") {
        // Unlink only this disposable native file, after the real SDK settled receipt.
        // Keep its directory so subsequent independent operations can create sessions.
        const requestId = heldEnd;
        NodeFSP.unlink(NodePath.join(sessions, native.sessionReference.slice(9)))
          .then(() => send({ type: "end", requestId }))
          .catch((error) => {
            throw error;
          });
        heldEnd = undefined;
        return;
      }
      if (scenario === "late-steer")
        send({ type: "control", controlId: 1, kind: "steer", text: "Late bounded steering" });
      else if (scenario === "late-interrupt") send({ type: "interrupt", controlId: 1 });
      send(
        scenario === "accounting-error"
          ? { type: "error", requestId: heldEnd, code: "ACCOUNTING_FAILURE" }
          : { type: "end", requestId: heldEnd },
      );
      heldEnd = undefined;
    }
  });
  function pushChunk() {
    if (response.offset === response.bytes.length) {
      if (
        requests.length === 2 &&
        [
          "held-end",
          "accounting-error",
          "late-steer",
          "late-interrupt",
          "persistence-loss",
        ].includes(scenario)
      )
        heldEnd = response.id;
      else send({ type: "end", requestId: response.id });
      response = undefined;
      return;
    }
    const end = Math.min(response.offset + 37, response.bytes.length);
    send({
      type: "chunk",
      requestId: response.id,
      data: response.bytes.subarray(response.offset, end).toString("base64"),
    });
    response.offset = end;
  }
  child.stdout.on("data", (bytes) => framer.push(bytes));
  const context =
    "\uFEFFExplicit bounded assignment briefing. " +
    "Older context fact Alpha. ".repeat(
      scenario === "tiny" ? 0 : scenario === "oversized-request" ? 300 : 128,
    );
  const prompt = "Use the assigned echo tool once.";
  const parameters = JSON.stringify({
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  });
  send({
    type: "bootstrap",
    executionMode: "ordinary",
    expectedCwd: scratch,
    native,
    context: { transferId: "context", totalBytes: Buffer.byteLength(context) },
    prompt:
      kind === "prompt" ? { transferId: "prompt", totalBytes: Buffer.byteLength(prompt) } : null,
    model: {
      provider: "p7-synthetic",
      modelId: "deterministic",
      api: "openai-completions",
      contextWindow: 32768,
      maxTokens: 512,
      reasoning: false,
    },
    allowedTools:
      kind === "prompt"
        ? [
            {
              name: "echo_assignment",
              description: "Echo bounded text",
              execution: scenario === "bridge" ? "bridge" : "local",
              inputSchema: { transferId: "schema", totalBytes: Buffer.byteLength(parameters) },
            },
          ]
        : [],
  });
  send({
    type: "transfer-chunk",
    transferId: "context",
    index: 0,
    offset: 0,
    data: Buffer.from(context).toString("base64"),
  });
  send({ type: "transfer-end", transferId: "context" });
  if (kind === "prompt") {
    send({
      type: "transfer-chunk",
      transferId: "prompt",
      index: 0,
      offset: 0,
      data: Buffer.from(prompt).toString("base64"),
    });
    send({ type: "transfer-end", transferId: "prompt" });
    send({
      type: "transfer-chunk",
      transferId: "schema",
      index: 0,
      offset: 0,
      data: Buffer.from(parameters).toString("base64"),
    });
    send({ type: "transfer-end", transferId: "schema" });
  }
  const result = await exited.promise;
  const expectedFailure = {
    interrupt: "CANCELED",
    "late-interrupt": "CANCELED",
    "late-steer": "INVALID_INPUT",
    "tool-denied": "TOOL_DENIED",
    "tool-output-limit": "TOOL_FAILURE",
    "accounting-error": "SDK_FAILURE",
    "unsafe-native-id": "SDK_FAILURE",
    "oversized-request": kind === "prompt" ? "SDK_FAILURE" : undefined,
    "persistence-loss": "PERSISTENCE_FAILURE",
    tiny: kind === "compact" ? "SDK_FAILURE" : undefined,
  }[scenario];
  if (expectedFailure) {
    NodeAssert.deepEqual(result, { code: 1, signal: null }, stderr);
    NodeAssert.equal(protocol.successful, false);
    NodeAssert.ok(
      frames.some((f) => f.type === "worker-failure" && f.code === expectedFailure),
      JSON.stringify(frames),
    );
    NodeAssert.ok(!frames.some((f) => ["done", "native", "compacted"].includes(f.type)));
    if (scenario === "late-steer") NodeAssert.ok(!frames.some((f) => f.type === "control-receipt"));
    evidence.push({ kind, scenario, pid: child.pid, exit: result, frames, requests, output });
    return native;
  }
  NodeAssert.deepEqual(result, { code: 0, signal: null }, stderr);
  framer.finish();
  NodeAssert.equal(protocol.successful, true, JSON.stringify(frames));
  NodeAssert.equal(
    requests.length,
    kind === "initialize" ? 0 : kind === "prompt" ? (scenario === "follow-up" ? 3 : 2) : 1,
  );
  const receipt = frames.find((f) =>
    ["initialized", "native", "compacted"].includes(f.type),
  ).native;
  const file = NodePath.join(sessions, receipt.sessionReference.slice("sessions/".length));
  const entries = (await NodeFSP.readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  NodeAssert.equal(entries[0].id, receipt.sessionId);
  NodeAssert.equal(entries.at(-1).id, receipt.leafId);
  NodeAssert.equal(entries.find((e) => e.type === "message").message.content[0].text, context);
  NodeAssert.ok(!JSON.stringify(entries).includes("AMBIENT_CONTEXT_SENTINEL"));
  NodeAssert.ok(!JSON.stringify(entries).includes("AMBIENT_AUTH_SENTINEL"));
  NodeAssert.equal((await NodeFSP.readdir(scratch)).includes("auth.json"), false);
  if (kind === "prompt") {
    NodeAssert.deepEqual(output, [
      { purpose: "tool-result", value: { kind: "text", text: "bounded echo" } },
    ]);
    NodeAssert.ok(frames.some((f) => f.type === "agent_start"));
    NodeAssert.ok(frames.some((f) => f.type === "agent_settled"));
    NodeAssert.ok(frames.some((f) => f.type === "sdk-event" && f.event.type === "tool_end"));
    if (["steer", "follow-up"].includes(scenario)) {
      NodeAssert.ok(
        frames.some(
          (f) => f.type === "control-receipt" && f.kind === scenario && f.controlId === 1,
        ),
      );
      NodeAssert.ok(JSON.stringify(requests).includes(`${scenario} bounded fact Beta.`));
    }
    if (native && entries.some((e) => e.type === "compaction")) {
      NodeAssert.ok(
        requests[0].messages.some((m) => JSON.stringify(m).includes("Native summary.")),
        "Resumed native summary remains in actual SDK request",
      );
      NodeAssert.ok(
        requests[0].messages.filter((m) =>
          JSON.stringify(m).includes("Use the assigned echo tool once."),
        ).length >= 2,
        "Native kept recent user request remains beside new prompt in actual context",
      );
    }
  } else if (kind === "compact") {
    NodeAssert.ok(frames.some((f) => f.type === "compaction_start"));
    NodeAssert.ok(frames.some((f) => f.type === "compaction_end"));
    NodeAssert.ok(!frames.some((f) => f.type === "agent_start"));
    NodeAssert.ok(entries.some((e) => e.type === "compaction" && e.summary === "Native summary."));
  }
  if (native) {
    NodeAssert.equal(receipt.sessionId, native.sessionId);
    NodeAssert.equal(receipt.sessionReference, native.sessionReference);
    NodeAssert.notEqual(receipt.leafId, native.leafId);
  }
  evidence.push({ kind, scenario, pid: child.pid, exit: result, frames, requests, output });
  return receipt;
}
try {
  const native = await operation("initialize");
  NodeAssert.equal(native.persisted, true);
  const prompted = await operation("prompt", native);
  const compacted = await operation("compact", prompted);
  let latest = await operation("prompt", compacted);
  latest = await operation("prompt", latest, "bridge");
  latest = await operation("prompt", latest, "steer");
  latest = await operation("prompt", latest, "follow-up");
  latest = await operation("prompt", latest, "held-end");
  // Each failure uses a fresh native session so a failed operation never spoofs a receipt
  // for the mutated branch of a previous successful operation.
  for (const scenario of [
    "interrupt",
    "late-interrupt",
    "late-steer",
    "tool-denied",
    "accounting-error",
    "unsafe-native-id",
    "oversized-request",
    "persistence-loss",
    "tool-output-limit",
  ]) {
    const fresh = await operation(
      "initialize",
      null,
      scenario === "oversized-request" ? scenario : "normal",
    );
    await operation("prompt", fresh, scenario);
  }
  const tiny = await operation("initialize", null, "tiny");
  await operation("compact", tiny, "tiny");
  process.stdout.write(JSON.stringify({ sdk: "0.99.1", remoteCalls: 0, evidence }) + "\n");
} finally {
  await NodeFSP.rm(scratch, { recursive: true, force: true });
}
