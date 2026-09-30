import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const ownedUnit = process.env.PI_RUNTIME_CONTRACT_OWNED_UNIT;
NodeAssert.ok(ownedUnit, "Linux systemd owned service is required before SDK startup");
const cgroupEntry = (await NodeFSP.readFile("/proc/self/cgroup", "utf8"))
  .trim()
  .split("\n")
  .find((line) => line.startsWith("0::"));
NodeAssert.ok(cgroupEntry);
const ownedPath = "/sys/fs/cgroup" + cgroupEntry.slice(3);
const controller = await new Promise((resolve, reject) =>
  NodeChildProcess.execFile(
    "systemctl",
    [
      "--user",
      "show",
      ownedUnit,
      "-p",
      "ControlGroup",
      "-p",
      "KillMode",
      "-p",
      "RuntimeMaxUSec",
      "-p",
      "TimeoutStopUSec",
    ],
    { timeout: 2000 },
    (error, stdout) => (error ? reject(error) : resolve(stdout)),
  ),
);
const policy = Object.fromEntries(
  controller
    .trim()
    .split("\n")
    .map((line) => line.split("=")),
);
const readOwned = (name) =>
  NodeFSP.readFile(NodePath.join(ownedPath, name), "utf8").then((text) => text.trim());
const owner = {
  unit: ownedUnit,
  path: ownedPath,
  policy,
  max: await readOwned("memory.max"),
  swapMax: await readOwned("memory.swap.max"),
  oomGroup: await readOwned("memory.oom.group"),
};
NodeAssert.equal(ownedPath, "/sys/fs/cgroup" + policy.ControlGroup);
NodeAssert.ok(ownedPath.endsWith("/" + ownedUnit));
NodeAssert.equal(policy.KillMode, "control-group");
NodeAssert.equal(policy.RuntimeMaxUSec, "10s");
NodeAssert.equal(policy.TimeoutStopUSec, "1s");
NodeAssert.equal(owner.max, "536870912");
NodeAssert.equal(owner.swapMax, "0");
NodeAssert.equal(owner.oomGroup, "1");
console.log("P1_OWNER:" + JSON.stringify(owner));
const ownedMembers = async () =>
  (await readOwned("cgroup.procs")).split("\n").filter(Boolean).map(Number);
const sdkRoot = process.env.PI_RUNTIME_CONTRACT_SDK_ROOT;
NodeAssert.ok(
  sdkRoot,
  "PI_RUNTIME_CONTRACT_SDK_ROOT must point to the pinned installed SDK package",
);
const sdkPackage = await NodeFSP.realpath(sdkRoot);
const metadata = JSON.parse(
  await NodeFSP.readFile(NodePath.join(sdkPackage, "package.json"), "utf8"),
);
NodeAssert.equal(metadata.name, "@earendil-works/pi-coding-agent");
NodeAssert.equal(metadata.version, "0.99.1");
globalThis.fetch = async () => {
  throw new Error("Network forbidden in deterministic SDK contract");
};
const sdk = await import(NodeURL.pathToFileURL(NodePath.join(sdkPackage, "dist/index.js")).href);
const aiMetadataPath = NodeModule.findPackageJSON(
  "@earendil-works/pi-ai",
  NodeURL.pathToFileURL(NodePath.join(sdkPackage, "dist/index.js")),
);
const aiMetadata = JSON.parse(await NodeFSP.readFile(aiMetadataPath, "utf8"));
NodeAssert.equal(aiMetadata.version, "0.99.1");
const { AssistantMessageEventStream } = await import(
  NodeURL.pathToFileURL(
    NodePath.join(NodePath.dirname(aiMetadataPath), "dist/utils/event-stream.js"),
  ).href
);
const directory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-p1-runtime-"));
const cwd = NodePath.join(scratch, "assigned-worktree");
const agentDir = NodePath.join(scratch, "trusted-agent");
await NodeFSP.mkdir(NodePath.join(cwd, ".pi/extensions"), { recursive: true });
await NodeFSP.mkdir(agentDir);
await NodeFSP.writeFile(NodePath.join(cwd, "cwd-marker.txt"), "assigned-worktree-marker");
await NodeFSP.writeFile(NodePath.join(cwd, "AGENTS.md"), "UNTRUSTED_RESOURCE_SENTINEL");
await NodeFSP.writeFile(
  NodePath.join(cwd, ".pi/extensions/rejected.mjs"),
  "throw Error('untrusted extension executed')",
);
const sessions = new Set();
const capturedPids = new Set();
const activeReceipts = new Set();
const cleanupReceipts = [];
const negativeControl = process.env.PI_RUNTIME_CONTRACT_NEGATIVE_CONTROL;
NodeAssert.ok(
  !negativeControl ||
    [
      "descendant-abort",
      "mcp-shutdown",
      "mcp-startup-stall",
      "shell-pre-receipt-stall",
      "cleanup-abort-stall",
      "cleanup-shutdown-stall",
    ].includes(negativeControl),
);
const records = [];
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let replies = [];
let beforeReply = async () => {};
let requestCount = 0;
const contexts = [];
const runtime = await sdk.ModelRuntime.create({
  authPath: NodePath.join(agentDir, "auth.json"),
  modelsPath: null,
  allowModelNetwork: false,
  refreshOnCreate: false,
});
runtime.registerProvider("p1-fixture", {
  api: "anthropic-messages",
  baseUrl: "http://127.0.0.1:1",
  apiKey: "synthetic-not-a-credential",
  models: [
    {
      id: "deterministic",
      name: "Deterministic",
      reasoning: false,
      input: ["text"],
      cost: usage.cost,
      contextWindow: 32000,
      maxTokens: 2048,
    },
  ],
  streamSimple: (model, context, options) => {
    NodeAssert.ok(++requestCount <= 20, "deterministic callback budget exceeded");
    contexts.push(context);
    const reply = replies.shift();
    NodeAssert.ok(reply, "unexpected SDK model request");
    const stream = new AssistantMessageEventStream();
    queueMicrotask(async () => {
      await beforeReply(context);
      const message = {
        role: "assistant",
        content: reply.content ?? [{ type: "text", text: "completed" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: reply.reason ?? "stop",
        timestamp: Date.now(),
        ...(reply.errorMessage ? { errorMessage: reply.errorMessage } : {}),
      };
      NodeAssert.ok(!options.signal.aborted);
      stream.push({ type: "start", partial: message });
      stream.push(
        reply.reason === "error"
          ? { type: "error", reason: "error", error: message }
          : { type: "done", reason: message.stopReason, message },
      );
    });
    return stream;
  },
});
const model = runtime.getModel("p1-fixture", "deterministic");
NodeAssert.ok(model);
const settings = () =>
  sdk.SettingsManager.inMemory({
    packages: [],
    blockImages: true,
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: { enabled: false },
  });
const trustedLoader = () => ({
  getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({
    agentsFiles: [
      { path: "trusted:assignment", content: "TRUSTED_ASSIGNMENT: investigation only" },
    ],
  }),
  getSystemPrompt: () => "T3 trusted instructions",
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
});
async function create(extra = {}) {
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    resourceLoader: trustedLoader(),
    sessionManager: sdk.SessionManager.inMemory(cwd),
    settingsManager: settings(),
    tools: [],
    thinkingLevel: "off",
    ...extra,
  });
  sessions.add(session);
  return session;
}
const toolCall = (name, argumentsValue = {}) => ({
  reason: "toolUse",
  content: [
    { type: "toolCall", id: `call-${requestCount}-${name}`, name, arguments: argumentsValue },
  ],
});
async function run(name, action) {
  if (
    negativeControl &&
    !(["descendant-abort", "shell-pre-receipt-stall", "cleanup-abort-stall"].includes(
      negativeControl,
    )
      ? name.includes("abort terminates")
      : name.includes("trusted MCP"))
  )
    return;
  const start = requestCount;
  const events = [];
  const details = await action(events);
  records.push({
    name,
    passed: true,
    kind: "actual-sdk/synthetic-stream",
    callbacks: requestCount - start,
    events,
    details,
  });
}
async function armExitReceipt(pids) {
  const observer = NodeChildProcess.spawn(
    "/usr/bin/python3",
    [
      "-c",
      String.raw`
import os,select,sys,json,signal
pids=json.loads(sys.argv[1])
fds={os.pidfd_open(pid):pid for pid in pids}
poller=select.poll()
for fd in fds: poller.register(fd,select.POLLIN)
poller.register(0,select.POLLIN|select.POLLHUP)
print('ready',flush=True)
remaining=set(fds)
cleanup=False
while remaining:
 for fd,event in poller.poll():
  if fd==0:
   os.read(0,4096)
   cleanup=True
   poller.unregister(0)
   for target in remaining:
    try: signal.pidfd_send_signal(target,signal.SIGKILL)
    except ProcessLookupError: pass
  else:
   remaining.discard(fd)
   poller.unregister(fd)
   print(json.dumps({'exited':fds[fd]}),flush=True)
print(json.dumps({'complete':True,'cleanup':cleanup,'pids':pids}),flush=True)
for fd in fds: os.close(fd)
`,
      JSON.stringify(pids),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  observer.stdin.on("error", () => {});
  let opened;
  let failed;
  const ready = new Promise((resolve, reject) => {
    opened = resolve;
    failed = reject;
  });
  let diagnostic = "";
  let output = "";
  let buffered = "";
  let complete;
  observer.stderr.on("data", (chunk) => {
    diagnostic += chunk;
  });
  observer.on("error", failed);
  observer.on("exit", (code) => {
    if (code !== 0) failed(new Error(diagnostic));
  });
  observer.stdout.on("data", (chunk) => {
    output += chunk;
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line === "ready") {
        opened();
        continue;
      }
      const receipt = JSON.parse(line);
      // Retire the numeric identity immediately upon kernel-confirmed exit.
      if (receipt.exited !== undefined) capturedPids.delete(receipt.exited);
      if (receipt.complete) {
        complete = receipt;
        activeReceipts.delete(owner);
        cleanupReceipts.push(receipt);
      }
    }
  });
  const exited = NodeEvents.once(observer, "close");
  const owner = {
    cleanup: async () => {
      if (!complete) observer.stdin.end("cleanup\n");
      await exited;
      NodeAssert.ok(complete, "pidfd cleanup did not produce a complete exit receipt");
    },
  };
  activeReceipts.add(owner);
  await ready;
  return async () => {
    NodeAssert.deepEqual(await exited, [0, null]);
    NodeAssert.ok(complete, "kernel exit receipt missing");
    NodeAssert.equal(complete.cleanup, false, "WATCHDOG_CLEANUP cannot satisfy SDK termination");
    return { output, receipt: complete };
  };
}
let deadline;
const watchdog = new Promise((resolve, reject) => {
  deadline = setTimeout(
    () => reject(new Error("WATCHDOG: SDK consumer did not terminate captured processes")),
    negativeControl ? 1500 : 20000,
  );
});
async function executeCases() {
  await run("AgentSession dispatch resolves assigned cwd and trusted resources", async (events) => {
    const session = await create({ tools: ["read"] });
    session.subscribe((event) => events.push(event.type));
    replies = [toolCall("read", { path: "cwd-marker.txt" }), {}];
    await session.prompt("Read the relative marker");
    await session.waitForIdle();
    const result = session.messages.find((message) => message.role === "toolResult");
    NodeAssert.match(JSON.stringify(result.content), /assigned-worktree-marker/);
    NodeAssert.equal(result.isError, false);
    NodeAssert.match(JSON.stringify(contexts.at(-1)), /TRUSTED_ASSIGNMENT: investigation only/);
    NodeAssert.ok(!JSON.stringify(contexts.at(-1)).includes("UNTRUSTED_RESOURCE_SENTINEL"));
    NodeAssert.equal(session.sessionManager.getCwd(), cwd);
    return { cwd, result, trustedContext: session.systemPrompt };
  });
  await run("Advertised custom tool enforces role denial in its handler", async (events) => {
    let writes = 0;
    let handlerCalls = 0;
    const customTools = [
      {
        name: "publish_assignment",
        label: "Publish",
        description: "Publishing requires integrator authority",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          handlerCalls++;
          const binding = { role: "investigator" };
          if (binding.role !== "integrator")
            throw new Error("ROLE_DENIED: investigator cannot publish");
          writes++;
          return { content: [{ type: "text", text: "published" }], details: {} };
        },
      },
    ];
    const session = await create({ tools: ["publish_assignment"], customTools });
    session.subscribe((event) => events.push(event.type));
    NodeAssert.ok(session.getActiveToolNames().includes("publish_assignment"));
    replies = [toolCall("publish_assignment"), {}];
    await session.prompt("Attempt publication");
    await session.waitForIdle();
    NodeAssert.equal(handlerCalls, 1);
    NodeAssert.equal(writes, 0);
    const result = session.messages.find((message) => message.role === "toolResult");
    NodeAssert.equal(result.isError, true);
    NodeAssert.match(JSON.stringify(result.content), /ROLE_DENIED/);
    return { handlerCalls, writes, result };
  });
  await run("Steering and follow-up drain before true settlement", async (events) => {
    const session = await create();
    session.subscribe((event) => events.push(event.type));
    let requests = 0;
    beforeReply = async () => {
      if (requests++ === 0) {
        NodeAssert.equal(await session.steer("steering assignment"), "queued");
        NodeAssert.equal(await session.followUp("follow-up assignment"), "queued");
      }
    };
    replies = [{}, {}, {}];
    await session.prompt("Initial assignment");
    await session.waitForIdle();
    beforeReply = async () => {};
    NodeAssert.equal(requests, 3);
    NodeAssert.equal(replies.length, 0);
    for (const text of ["steering assignment", "follow-up assignment"])
      NodeAssert.ok(
        session.messages.some(
          (message) => message.role === "user" && JSON.stringify(message.content).includes(text),
        ),
      );
    NodeAssert.equal(events.filter((event) => event === "agent_settled").length, 1);
    NodeAssert.equal(events.at(-1), "agent_settled");
    NodeAssert.ok(session.isIdle);
    return { requests, messages: session.messages };
  });
  await run("Transient failure cannot settle before successful retry", async (events) => {
    const session = await create({
      settingsManager: sdk.SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
      }),
    });
    session.subscribe((event) => events.push(event.type));
    replies = [{ reason: "error", errorMessage: "429 rate limit", content: [] }, {}];
    await session.prompt("Retry race");
    await session.waitForIdle();
    NodeAssert.equal(events.filter((event) => event === "agent_end").length, 2);
    NodeAssert.equal(events.filter((event) => event === "agent_settled").length, 1);
    NodeAssert.ok(events.indexOf("agent_end") < events.lastIndexOf("agent_start"));
    NodeAssert.equal(session.messages.at(-1).stopReason, "stop");
    NodeAssert.equal(events.at(-1), "agent_settled");
    return { messages: session.messages };
  });
  await run(
    "Explicit trusted MCP invokes allowed and denied advertised handlers",
    async (events) => {
      const auditPath = NodePath.join(scratch, "mcp-audit.jsonl");
      const mcp = sdk.createMcpExtension({
        loadConfig: () => ({
          servers: [
            {
              name: "trusted",
              source: "T3 controlled",
              scope: "extension",
              config: {
                command: process.execPath,
                args: [
                  "--max-old-space-size=128",
                  NodePath.join(directory, "p1-runtime-mcp.mjs"),
                  auditPath,
                  negativeControl ?? "",
                ],
                cwd,
                exposure: "direct",
              },
            },
          ],
          errors: [],
          autoEnableCodemode: false,
        }),
        logPath: NodePath.join(scratch, "mcp.log"),
        openUrl: () => {
          throw new Error("Browser forbidden");
        },
        updateConfig: () => {
          throw new Error("Config mutation forbidden");
        },
      });
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: settings(),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [mcp],
        systemPrompt: "T3 trusted",
      });
      await resourceLoader.reload();
      const session = await create({ resourceLoader, tools: undefined, noTools: "builtin" });
      if (negativeControl === "cleanup-shutdown-stall") {
        const emit = session.extensionRunner.emit.bind(session.extensionRunner);
        session.extensionRunner.emit = (event) =>
          event.type === "session_shutdown" ? new Promise(() => {}) : emit(event);
      }
      await session.bindExtensions({});
      session.subscribe((event) => events.push(event.type));
      replies = [
        toolCall("mcp__trusted__read_assignment"),
        toolCall("mcp__trusted__publish_assignment"),
        {},
      ];
      await session.prompt("Read then attempt publication");
      await session.waitForIdle();
      NodeAssert.ok(session.getActiveToolNames().includes("mcp__trusted__publish_assignment"));
      const results = session.messages.filter((message) => message.role === "toolResult");
      NodeAssert.match(JSON.stringify(results[0].content), /assignment-read/);
      NodeAssert.match(JSON.stringify(results[1].content), /ROLE_DENIED/);
      NodeAssert.equal(results[1].isError, true);
      const audit = (await NodeFSP.readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      NodeAssert.deepEqual(audit, [
        { tool: "read_assignment", allowed: true },
        { tool: "publish_assignment", allowed: false },
      ]);
      const pid = Number(await NodeFSP.readFile(auditPath + ".pid", "utf8"));
      capturedPids.add(pid);
      const waitForExit = await armExitReceipt([pid]);
      if (negativeControl !== "mcp-shutdown")
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
      const exitNotification = await waitForExit();
      return { audit, results, pid, exitNotification };
    },
  );
  await run("AgentSession abort terminates captured shell and descendants", async (events) => {
    // This standalone dependency fixture measures the actual host rather than the product runtime abstraction.
    // oxlint-disable-next-line t3code/no-global-process-runtime
    NodeAssert.equal(NodeOS.platform(), "linux", "This process-tree proof requires Linux pidfd");
    const session = await create({ tools: ["bash"] });
    if (negativeControl === "cleanup-abort-stall") session.abort = () => new Promise(() => {});
    let ready;
    const started = new Promise((resolve) => {
      ready = resolve;
    });
    session.subscribe((event) => {
      events.push(event.type);
      if (event.type !== "tool_execution_update") return;
      const output = event.partialResult.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      const match = output.match(/\{"pids":\[([\d,]+)\]\}/);
      if (match) {
        for (const pid of JSON.parse(match[0]).pids) capturedPids.add(pid);
        ready();
      }
    });
    const script = NodePath.join(directory, "p1-runtime-descendants.mjs");
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    replies = [
      toolCall("bash", {
        command: `${quote(process.execPath)} --max-old-space-size=128 ${quote(script)} $$ ${quote(NodePath.join(scratch, "shell-owned.json"))} ${quote(negativeControl ?? "")}; :`,
      }),
    ];
    const prompt = session.prompt("Start captured descendants");
    await started;
    NodeAssert.equal(capturedPids.size, 3);
    // Open pidfds before cancellation, then wait on kernel exit notifications.
    const waitForExit = await armExitReceipt([...capturedPids]);
    if (negativeControl !== "descendant-abort") await session.abort();
    if (!negativeControl) await prompt;
    if (!negativeControl) await session.waitForIdle();
    const output = await waitForExit();
    NodeAssert.ok(session.isIdle);
    NodeAssert.equal(events.at(-1), "agent_settled");
    return { pids: output.receipt.pids, exitNotification: output, liveProcessesAfterAbort: 0 };
  });
}
let failure;
let cleanupCause;
let membersBeforeCleanup;
let membersAfterCleanup;
try {
  await Promise.race([executeCases(), watchdog]);
} catch (error) {
  failure = error;
} finally {
  membersBeforeCleanup = await ownedMembers();
  let cleanupTimer;
  const cleanupDeadline = new Promise((resolve, reject) => {
    cleanupTimer = setTimeout(
      () => reject(new Error("CLEANUP_DEADLINE: SDK abort or shutdown did not complete")),
      1500,
    );
  });
  const cleanup = (async () => {
    await Promise.all([...activeReceipts].map((owner) => owner.cleanup()));
    for (const session of sessions) {
      await session.abort();
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "exit" });
      session.dispose();
    }
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  })();
  try {
    // Preserve the main deadline through cleanup; use a fresh bound after it already failed.
    await Promise.race(failure ? [cleanup, cleanupDeadline] : [cleanup, cleanupDeadline, watchdog]);
    membersAfterCleanup = await ownedMembers();
    if (!failure)
      NodeAssert.deepEqual(
        membersAfterCleanup,
        [process.pid],
        "SDK left an owned child alive after successful cleanup",
      );
  } catch (error) {
    cleanupCause = error.message;
    failure ??= error;
  } finally {
    clearTimeout(deadline);
    clearTimeout(cleanupTimer);
  }
}
const report = failure
  ? {
      status: "failed",
      cause: failure.message,
      cleanupCause,
      negativeControl,
      cleanupReceipts,
      ownedMembersBeforeCleanup: membersBeforeCleanup,
      ownedMembersAfterCleanup: membersAfterCleanup,
      ownedPeak: await readOwned("memory.peak"),
      remoteCalls: 0,
    }
  : {
      pin: metadata.version,
      remoteCalls: 0,
      callbackCount: requestCount,
      resources: {
        nodeMaxRssKiB: process.resourceUsage().maxRSS,
        nodeHeapLimitMiB: 128,
        ownedPeak: await readOwned("memory.peak"),
      },
      records,
      cleanupReceipts,
      ownedMembersBeforeCleanup: membersBeforeCleanup,
      ownedMembersAfterCleanup: membersAfterCleanup,
    };
await new Promise((resolve) =>
  (failure ? process.stderr : process.stdout).write(JSON.stringify(report) + "\n", resolve),
);
// The independent, pre-existing service owns any opening/unacknowledged child; its
// KillMode and external deadline remain authoritative after this fixture exits.
process.exit(failure ? (cleanupCause ? 2 : 1) : 0);
