import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

// This trusted Linux fixture exercises actual byte IPC without importing SDK/runtime code.
const mode = process.argv[2];
let identity;
let sequence = 0;
let bootstrap;
let remaining = 0;
let request = 0;
const native = (leafId = null, persisted = false) => ({
  sessionId: "session",
  sessionReference: "sessions/session.jsonl",
  leafId,
  persisted,
});
const send = (message, extra = {}) =>
  process.stdout.write(
    JSON.stringify({ version: 1, ...identity, sequence: sequence++, message, ...extra }) + "\n",
  );
async function finish() {
  send({
    type: "sdk-event",
    lifecycleId: 1,
    event: { type: "assistant_result", stopReason: "stop" },
  });
  send({ type: "agent_end", lifecycleId: 1 });
  send({ type: "agent_settled", lifecycleId: 1 });
  send(
    {
      type: "native",
      lifecycleId: 1,
      native: native(mode === "forged-native" ? null : "leaf", true),
    },
    mode === "forged-generation" ? { generation: identity.generation + 1 } : {},
  );
  send(
    { type: "operation_settled", lifecycleId: 1, outcome: "success" },
    mode === "forged-operation" ? { operationId: "other" } : {},
  );
  send({ type: "done" }, mode === "forged-sequence" ? { sequence: 999 } : {});
  if (mode === "descendant") {
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
      { stdio: "ignore", detached: true },
    );
    await NodeFSP.writeFile("/workspace/descendant-pid", String(child.pid));
    child.unref();
  }
}
function start() {
  send({ type: "ready", actualCwd: process.cwd(), native: native() });
  if (identity.operationKind === "initialize") {
    send({ type: "initialized", native: native(null, true) });
    return;
  }
  if (mode === "malformed") {
    process.stdout.write("invalid\n");
    return;
  }
  if (mode === "early-exit") {
    process.exit(0);
  }
  send({ type: "agent_start", lifecycleId: 1 });
  if (mode === "tool" || mode === "local-tool") {
    const text = JSON.stringify({ arguments: { text: "assignment" } });
    send({
      type: "tool-call",
      callId: 1,
      nativeCallId: "native_call",
      lifecycleId: 1,
      toolName: "echo_assignment",
      execution: mode === "local-tool" ? "local" : "bridge",
      input: { transferId: "input", totalBytes: Buffer.byteLength(text) },
    });
    send({
      type: "transfer-chunk",
      transferId: "input",
      index: 0,
      offset: 0,
      data: Buffer.from(text).toString("base64"),
    });
    send({ type: "transfer-end", transferId: "input" });
  } else modelRequest();
}
function modelRequest() {
  send({
    type: "request",
    requestId: ++request,
    lifecycleId: 1,
    body: JSON.stringify({
      model: bootstrap.model.modelId,
      messages: [{ role: "user", content: "assignment" }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: bootstrap.model.maxTokens,
    }),
  });
}
async function receive(line) {
  if (Buffer.byteLength(line) > 16384) throw new Error("fixture frame bound");
  const frame = JSON.parse(line);
  const message = frame.message;
  if (message.type === "bootstrap") {
    identity = {
      workerId: frame.workerId,
      generation: frame.generation,
      operationId: frame.operationId,
      operationKind: frame.operationKind,
    };
    bootstrap = message;
    remaining =
      1 +
      (bootstrap.prompt ? 1 : 0) +
      bootstrap.allowedTools.filter((tool) => tool.inputSchema).length;
  }
  if (message.type === "transfer-end") {
    if (message.transferId.startsWith("parent_tool_")) {
      send({
        type: "sdk-event",
        lifecycleId: 1,
        event: { type: "tool_end", callId: 1, toolName: "echo_assignment", isError: false },
      });
      modelRequest();
    } else if (--remaining === 0) start();
  }
  if (message.type === "chunk") {
    if (mode !== "blocked-ack")
      send({ type: "ack", requestId: message.requestId, chunkSequence: frame.sequence });
  }
  if (message.type === "end") await finish();
  if (message.type === "tool-authorized") {
    send({
      type: "sdk-event",
      lifecycleId: 1,
      event: { type: "tool_start", callId: 1, toolName: "echo_assignment" },
    });
    if (mode === "local-tool") {
      await NodeFSP.writeFile("/workspace/local-tool", "executed");
      const text = JSON.stringify({ kind: "text", text: "local" });
      send({
        type: "tool-result",
        callId: 1,
        output: { transferId: "local_output", totalBytes: Buffer.byteLength(text) },
      });
      send({
        type: "transfer-chunk",
        transferId: "local_output",
        index: 0,
        offset: 0,
        data: Buffer.from(text).toString("base64"),
      });
      send({ type: "transfer-end", transferId: "local_output" });
      send({
        type: "sdk-event",
        lifecycleId: 1,
        event: { type: "tool_end", callId: 1, toolName: "echo_assignment", isError: false },
      });
      modelRequest();
    }
  }
  if (message.type === "control" || message.type === "interrupt") {
    if (mode === "unresolved-control") send({ type: "worker-failure", code: "INVALID_INPUT" });
    else
      send({
        type: "control-receipt",
        controlId: message.controlId,
        kind: message.type === "interrupt" ? "interrupt" : message.kind,
      });
  }
}

const held = Buffer.alloc(16384);
const utf8 = new TextDecoder("utf-8", { fatal: true });
let length = 0;
for await (const chunk of process.stdin) {
  for (let offset = 0; offset < chunk.length;) {
    const newline = chunk.indexOf(10, offset);
    const end = newline < 0 ? chunk.length : newline;
    if (length + end - offset + 1 > held.length) throw new Error("fixture frame bound");
    held.set(chunk.subarray(offset, end), length);
    length += end - offset;
    if (newline >= 0) {
      await receive(utf8.decode(held.subarray(0, length)));
      length = 0;
    }
    offset = newline < 0 ? end : newline + 1;
  }
}
if (length !== 0) throw new Error("fixture incomplete frame");
