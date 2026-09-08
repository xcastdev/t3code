import * as NodeURL from "node:url";
import { expect, it, onTestFinished } from "@effect/vitest";
import { McpServerId } from "@t3tools/contracts";
import { ProjectMcpBroker } from "./ProjectMcpBroker.ts";
import { connectProjectMcpServer } from "./ProjectMcpConnection.ts";
import { vi } from "@effect/vitest";

const openConnection = async () => {
  const serverId = McpServerId.make("task1-stdio");
  return connectProjectMcpServer({
    serverId,
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [
        NodeURL.fileURLToPath(new URL("./ProjectMcpBroker.stdio.fixture.mjs", import.meta.url)),
      ],
      env: [],
    },
    resolveSecret: () => undefined,
  });
};
const open = async (now?: () => number) => {
  const connection = await openConnection();
  const broker = new ProjectMcpBroker({
    connection,
    serverId: McpServerId.make("task1-stdio"),
    providerSessionId: "fixture",
    downstreamProtocolEra: "modern",
    ...(now ? { now } : {}),
    handlers: {
      onRootsRequest: () => {
        throw new Error("unassociated roots");
      },
    },
  });
  onTestFinished(() => broker.close());
  return broker;
};

it("serializes last-owner unsubscribe with a new legacy facade subscription", async () => {
  const connection = await openConnection();
  onTestFinished(() => connection.close());
  const options = {
    connection,
    serverId: McpServerId.make("task1-stdio"),
    providerSessionId: "fixture",
  };
  const first = new ProjectMcpBroker(options);
  const second = new ProjectMcpBroker(options);
  const resource = { uri: "file:///fixture" };
  await first.subscribeResource(resource);
  await Promise.all([first.unsubscribeResource(resource), second.subscribeResource(resource)]);
  expect((await second.callTool({ name: "subscriptions" })).content).toEqual([
    { type: "text", text: "1" },
  ]);
});

it("delivers resource updates only to legacy facades that still own the URI", async () => {
  const connection = await openConnection();
  onTestFinished(() => connection.close());
  const options = {
    connection,
    serverId: McpServerId.make("task1-stdio"),
    providerSessionId: "fixture",
  };
  const first = new ProjectMcpBroker(options);
  const second = new ProjectMcpBroker(options);
  const firstUpdates: string[] = [];
  const secondUpdates: string[] = [];
  first.setHandlers({
    onResourceUpdated: (uri) => {
      firstUpdates.push(uri);
    },
  });
  second.setHandlers({
    onResourceUpdated: (uri) => {
      secondUpdates.push(uri);
    },
  });
  const resource = { uri: "file:///fixture" };
  await first.subscribeResource(resource);
  await second.callTool({ name: "emit" });
  await second.ping();
  expect(firstUpdates).toEqual([resource.uri]);
  expect(secondUpdates).toEqual([]);
  await second.subscribeResource(resource);
  await first.unsubscribeResource(resource);
  await second.callTool({ name: "emit" });
  await second.ping();
  expect(firstUpdates).toEqual([resource.uri]);
  expect(secondUpdates).toEqual([resource.uri]);
});

it("cancels a queued same-URI subscription before the active tool releases its permit", async () => {
  const connection = await openConnection();
  onTestFinished(() => connection.close());
  const options = {
    connection,
    serverId: McpServerId.make("task1-stdio"),
    providerSessionId: "fixture",
  };
  const modern = new ProjectMcpBroker({ ...options, downstreamProtocolEra: "modern" });
  const first = new ProjectMcpBroker(options);
  const second = new ProjectMcpBroker(options);
  await modern.callTool({ name: "roots" });
  const resource = { uri: "file:///fixture" };
  const queued = first.subscribeResource(resource).catch(() => undefined);
  const abort = new AbortController();
  const cancelled = expect(
    second.subscribeResource(resource, { signal: abort.signal }),
  ).rejects.toThrow("cancelled");
  abort.abort(new Error("cancelled"));
  await cancelled;
  await connection.close();
  await queued;
});

it("serializes modern and legacy facades sharing the same stdio connection", async () => {
  const connection = await openConnection();
  const options = {
    connection,
    serverId: McpServerId.make("task1-stdio"),
    providerSessionId: "fixture",
  };
  const modern = new ProjectMcpBroker({ ...options, downstreamProtocolEra: "modern" });
  try {
    const first = await modern.callTool({ name: "roots" });
    // Creating this facade must neither steal the suspended input handler nor bypass its permit.
    const legacy = new ProjectMcpBroker({
      ...options,
      downstreamProtocolEra: "legacy",
      handlers: {
        onRootsRequest: () => ({ roots: [{ uri: "file:///legacy" }] }),
      },
    });
    const queued = legacy.callTool({ name: "roots" });
    expect((await modern.callTool(resume(first, "file:///modern"))).content).toEqual([
      { type: "text", text: "file:///modern" },
    ]);
    expect((await queued).content).toEqual([{ type: "text", text: "file:///legacy" }]);
    const suspended = await modern.callTool({ name: "roots" });
    await connection.close();
    await expect(modern.callTool(resume(suspended, "file:///closed"))).rejects.toMatchObject({
      code: "invalid_request_state",
    });
  } finally {
    await connection.close();
  }
});

it("binds a continuation's new progress metadata to the original operation", async () => {
  const broker = await open();
  try {
    const first = await broker.callTool({ name: "roots", _meta: { progressToken: "first" } });
    expect(
      (
        await broker.callTool({
          ...resume(first, "file:///fixture"),
          _meta: { progressToken: "second" },
        })
      ).content,
    ).toEqual([{ type: "text", text: "file:///fixture" }]);
  } finally {
    await broker.close();
  }
});

const resume = (
  first: Awaited<ReturnType<ProjectMcpBroker["callTool"]>>,
  uri: string,
  params = { name: "roots" },
) => {
  if (first.resultType !== "input_required" || typeof first.requestState !== "string")
    throw new Error("expected input");
  return {
    ...params,
    requestState: first.requestState,
    inputResponses: { [Object.keys(first.inputRequests!)[0]!]: { roots: [{ uri }] } },
  };
};

it("claims each continuation once, including duplicate concurrent resumes", async () => {
  const broker = await open();
  try {
    const first = await broker.callTool({ name: "roots" });
    const params = resume(first, "file:///first");
    const results = await Promise.allSettled([broker.callTool(params), broker.callTool(params)]);
    expect(results[0]).toMatchObject({
      status: "fulfilled",
      value: { content: [{ type: "text", text: "file:///first" }] },
    });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: { code: "invalid_request_state" },
    });
    await expect(broker.callTool(params)).rejects.toMatchObject({ code: "invalid_request_state" });
  } finally {
    await broker.close();
  }
});

it.each([false, true])("isolates queued calls, identical arguments: %s", async (identical) => {
  const broker = await open();
  try {
    const firstParams = { name: "roots", arguments: { id: "first" } };
    const secondParams = identical ? firstParams : { name: "roots", arguments: { id: "second" } };
    const first = await broker.callTool(firstParams);
    const secondCall = broker.callTool(secondParams);
    await expect(
      broker.callTool({
        ...resume(first, "file:///wrong", firstParams),
        requestState: "malformed",
      }),
    ).rejects.toMatchObject({ code: "invalid_request_state" });
    expect((await broker.callTool(resume(first, "file:///first", firstParams))).content).toEqual([
      { type: "text", text: "file:///first" },
    ]);
    const second = await secondCall;
    await expect(
      broker.callTool(resume(first, "file:///crossed", secondParams)),
    ).rejects.toMatchObject({ code: "invalid_request_state" });
    expect((await broker.callTool(resume(second, "file:///second", secondParams))).content).toEqual(
      [{ type: "text", text: "file:///second" }],
    );
  } finally {
    await broker.close();
  }
});

it("queues simultaneous pushes into successive rounds of the original invocation", async () => {
  const broker = await open();
  try {
    const params = { name: "parallel" };
    const first = await broker.callTool(params);
    const second = await broker.callTool(resume(first, "file:///first", params));
    expect(second.resultType).toBe("input_required");
    expect((await broker.callTool(resume(second, "file:///second", params))).content).toEqual([
      { type: "text", text: "file:///second" },
    ]);
    expect((await broker.callTool({ name: "count" })).content).toEqual([
      { type: "text", text: "1" },
    ]);
  } finally {
    await broker.close();
  }
});

it("aborts queued operations and detaches the caller while input is suspended", async () => {
  const broker = await open();
  try {
    const caller = new AbortController();
    const first = await broker.callTool({ name: "roots" }, { signal: caller.signal });
    caller.abort(new Error("finished HTTP request"));
    const queued = new AbortController();
    const pending = broker.listTools(undefined, { signal: queued.signal });
    queued.abort(new Error("queued cancelled"));
    await expect(pending).rejects.toThrow("queued cancelled");
    expect((await broker.callTool(resume(first, "file:///fixture"))).content).toEqual([
      { type: "text", text: "file:///fixture" },
    ]);
  } finally {
    await broker.close();
  }
});

it("closes suspended invocations and rejects queued operations and stale resumes", async () => {
  const broker = await open();
  try {
    const first = await broker.callTool({ name: "roots" });
    const queued = broker.callTool({ name: "roots" });
    const rejected = expect(queued).rejects.toThrow("closed");
    await broker.close();
    await rejected;
    await expect(broker.callTool(resume(first, "file:///fixture"))).rejects.toMatchObject({
      code: "invalid_request_state",
    });
  } finally {
    await broker.close();
  }
});

it("expires suspended invocations and releases the queued operation", async () => {
  const broker = await open();
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = await broker.callTool({ name: "roots" });
    const queued = broker.callTool({ name: "count" });
    await vi.advanceTimersByTimeAsync(600_000);
    expect((await queued).content).toEqual([{ type: "text", text: "1" }]);
    await expect(broker.callTool(resume(first, "file:///fixture"))).rejects.toMatchObject({
      code: "invalid_request_state",
    });
  } finally {
    vi.useRealTimers();
    await broker.close();
  }
});

it("routes progress to the resumed caller only", async () => {
  const broker = await open();
  try {
    const original: unknown[] = [];
    const resumed: unknown[] = [];
    const first = await broker.callTool(
      { name: "roots" },
      { onprogress: (value) => original.push(value) },
    );
    await broker.callTool(resume(first, "file:///fixture"), {
      onprogress: (value) => resumed.push(value),
    });
    expect(original).toEqual([]);
    expect(resumed).toEqual([expect.objectContaining({ progress: 1, message: "file:///fixture" })]);
  } finally {
    await broker.close();
  }
});

it("cancels an active continuation and releases its original invocation", async () => {
  const broker = await open();
  try {
    const first = await broker.callTool({ name: "roots" });
    const abort = new AbortController();
    const resumed = broker.callTool(resume(first, "file:///cancelled"), { signal: abort.signal });
    abort.abort(new Error("active cancelled"));
    await expect(resumed).rejects.toThrow("active cancelled");
    await expect(broker.callTool(resume(first, "file:///replay"))).rejects.toMatchObject({
      code: "invalid_request_state",
    });
    expect((await broker.callTool({ name: "count" })).content).toEqual([
      { type: "text", text: "1" },
    ]);
  } finally {
    await broker.close();
  }
});

it("keeps the invocation alive past the SDK default timeout within the continuation TTL", async () => {
  const broker = await open();
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = await broker.callTool({ name: "roots" });
    await vi.advanceTimersByTimeAsync(60_001);
    expect((await broker.callTool(resume(first, "file:///fixture"))).content).toEqual([
      { type: "text", text: "file:///fixture" },
    ]);
  } finally {
    vi.useRealTimers();
    await broker.close();
  }
});

it("resumes a real legacy stdio invocation without repeating its side effect", async () => {
  const serverId = McpServerId.make("task1-stdio");
  const connection = await connectProjectMcpServer({
    serverId,
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [
        NodeURL.fileURLToPath(new URL("./ProjectMcpBroker.stdio.fixture.mjs", import.meta.url)),
      ],
      env: [],
    },
    resolveSecret: () => undefined,
  });
  const broker = new ProjectMcpBroker({
    connection,
    serverId,
    providerSessionId: "fixture",
    downstreamProtocolEra: "modern",
    handlers: {
      onRootsRequest: () => {
        throw new Error("unassociated roots");
      },
    },
  });
  try {
    const first = await broker.callTool({ name: "roots" });
    expect(first.resultType).toBe("input_required");
    if (first.resultType !== "input_required" || typeof first.requestState !== "string")
      throw new Error("expected input");
    const key = Object.keys(first.inputRequests!)[0]!;
    const completed = await broker.callTool({
      name: "roots",
      requestState: first.requestState,
      inputResponses: { [key]: { roots: [{ uri: "file:///fixture" }] } },
    });
    expect(completed.content).toEqual([{ type: "text", text: "file:///fixture" }]);
    expect((await broker.callTool({ name: "count" })).content).toEqual([
      { type: "text", text: "1" },
    ]);
  } finally {
    await broker.close();
  }
});
