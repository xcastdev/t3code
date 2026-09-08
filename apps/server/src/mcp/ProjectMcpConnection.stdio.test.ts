import * as NodeURL from "node:url";
import { expect, it } from "@effect/vitest";
import { McpServerId } from "@t3tools/contracts";
import {
  connectProjectMcpServer,
  projectMcpConnectionCoordinator,
} from "./ProjectMcpConnection.ts";
import type {
  ProjectMcpConnection,
  ProjectMcpConnectionCoordinator,
} from "./ProjectMcpConnection.ts";
import { ProjectMcpBroker } from "./ProjectMcpBroker.ts";
import { ProtocolErrorCode } from "@modelcontextprotocol/client";

it("owns modern subscriptions once and delivers updates until unsubscribe or close", async ({
  onTestFinished,
}) => {
  const serverId = McpServerId.make("modern-stdio");
  const connection = await connectProjectMcpServer({
    serverId,
    transport: {
      type: "stdio",
      command: process.execPath,
      env: [],
      args: [
        NodeURL.fileURLToPath(new URL("./ProjectMcpConnection.stdio.fixture.mjs", import.meta.url)),
      ],
    },
    resolveSecret: () => undefined,
  });
  onTestFinished(() => connection.close());
  const first = new ProjectMcpBroker({ connection, serverId, providerSessionId: "first" });
  const second = new ProjectMcpBroker({ connection, serverId, providerSessionId: "second" });
  const a = Promise.withResolvers<void>();
  const b = Promise.withResolvers<void>();
  let firstDeliveries = 0;
  const disposeFirst = first.setHandlers({
    onToolsChanged: () => {
      firstDeliveries += 1;
      a.resolve();
    },
  });
  second.setHandlers({ onToolsChanged: () => b.resolve() });
  try {
    await first.callTool({ name: "emit" });
    await Promise.all([a.promise, b.promise]);
    expect(connection.protocolEra).toBe("modern");
    expect((await first.callTool({ name: "subscriptions" })).content).toEqual([
      { type: "text", text: '{"opened":1,"active":1}' },
    ]);
    const prompts = Promise.withResolvers<void>();
    const resources = Promise.withResolvers<void>();
    let updated = Promise.withResolvers<void>();
    let updates = 0;
    second.setHandlers({
      onPromptsChanged: () => prompts.resolve(),
      onResourcesChanged: () => resources.resolve(),
      onResourceUpdated: (uri) => {
        expect(uri).toBe("file:///fixture");
        updates += 1;
        updated.resolve();
      },
    });
    await Promise.all([
      first.subscribeResource({ uri: "file:///fixture" }),
      second.subscribeResource({ uri: "file:///fixture" }),
    ]);
    expect((await first.callTool({ name: "subscriptions" })).content).toEqual([
      { type: "text", text: '{"opened":2,"active":2}' },
    ]);
    disposeFirst();
    await first.callTool({ name: "emit" });
    await Promise.all([prompts.promise, resources.promise, updated.promise]);
    expect(firstDeliveries).toBe(1);
    await first.unsubscribeResource({ uri: "file:///fixture" });
    updated = Promise.withResolvers<void>();
    await first.callTool({ name: "emit" });
    await updated.promise;
    expect(updates).toBe(2);
    await second.unsubscribeResource({ uri: "file:///fixture" });
    expect((await first.callTool({ name: "subscriptions" })).content).toEqual([
      { type: "text", text: '{"opened":2,"active":1}' },
    ]);
    await first.callTool({ name: "emit" });
    await first.callTool({ name: "subscriptions" });
    expect(updates).toBe(2);
    await connection.close();
    await expect(first.subscribeResource({ uri: "file:///fixture" })).rejects.toThrow("closed");
  } finally {
    await connection.close();
  }
});

it("releases roots ownership on replacement and connection close", async () => {
  let rootsRequest:
    | ((request: unknown, context: unknown) => unknown | Promise<unknown>)
    | undefined;
  const client = {
    connect: async () => undefined,
    close: async () => undefined,
    setRequestHandler: (
      method: string,
      handler: (request: unknown, context: unknown) => unknown,
    ) => {
      if (method === "roots/list") rootsRequest = handler;
    },
  };
  const connection = {
    client,
    transport: { type: "stdio", command: "fixture", args: [], env: [] } as const,
    protocolEra: "legacy" as const,
    negotiatedProtocolVersion: "2025-11-25",
    discoverResult: undefined,
    close: async () => undefined,
  };
  const coordinator = projectMcpConnectionCoordinator(
    connection as unknown as ProjectMcpConnection,
  );
  if (!rootsRequest) throw new Error("roots request handler was not registered");
  const first = {};
  const second = {};
  coordinator.replaceRootsOwner(first, () => ({ roots: [{ uri: "file:///first" }] }));
  coordinator.replaceRootsOwner(second, () => ({ roots: [{ uri: "file:///second" }] }));
  const context = { mcpReq: { signal: new AbortController().signal } };
  expect(await rootsRequest({ method: "roots/list" }, context)).toEqual({
    roots: [{ uri: "file:///second" }],
  });
  coordinator.releaseRootsOwner(first);
  expect(await rootsRequest({ method: "roots/list" }, context)).toEqual({
    roots: [{ uri: "file:///second" }],
  });
  coordinator.releaseRootsOwner(second);
  await expect(
    Promise.resolve().then(() => rootsRequest!({ method: "roots/list" }, context)),
  ).rejects.toMatchObject({ code: ProtocolErrorCode.MethodNotFound });
  expect(
    coordinator.replaceRootsOwner(first, () => ({ roots: [{ uri: "file:///first" }] })),
  ).toBeUndefined();
  await coordinator.close();
  await expect(
    Promise.resolve().then(() => rootsRequest!({ method: "roots/list" }, context)),
  ).rejects.toMatchObject({ code: ProtocolErrorCode.MethodNotFound });
});

it("tracks roots owner generations through failure, release, and close", async () => {
  const makeCoordinator = () => {
    let rootsRequest:
      | ((request: unknown, context: unknown) => unknown | Promise<unknown>)
      | undefined;
    const client = {
      connect: async () => undefined,
      close: async () => undefined,
      setRequestHandler: (
        method: string,
        handler: (request: unknown, context: unknown) => unknown,
      ) => {
        if (method === "roots/list") rootsRequest = handler;
      },
    };
    const connection = {
      client,
      transport: { type: "stdio", command: "fixture", args: [], env: [] } as const,
      protocolEra: "legacy" as const,
      negotiatedProtocolVersion: "2025-11-25",
      discoverResult: undefined,
      close: async () => undefined,
    };
    const coordinator = projectMcpConnectionCoordinator(
      connection as unknown as ProjectMcpConnection,
    );
    if (!rootsRequest) throw new Error("roots request handler was not registered");
    const context = { mcpReq: { signal: new AbortController().signal } };
    return {
      coordinator,
      rootsList: () =>
        Promise.resolve().then(() => rootsRequest!({ method: "roots/list" }, context)),
    };
  };
  const retainedRootsGenerations = (coordinator: ProjectMcpConnectionCoordinator) => {
    let count = 0;
    let record = (coordinator as unknown as { rootsOwner?: { previous?: unknown } }).rootsOwner;
    while (record !== undefined) {
      count += 1;
      record = record.previous as typeof record;
    }
    return count;
  };
  const expectNoRootsOwner = async (rootsList: () => Promise<unknown>) => {
    await expect(rootsList()).rejects.toMatchObject({ code: ProtocolErrorCode.MethodNotFound });
  };

  {
    const { coordinator, rootsList } = makeCoordinator();
    for (let index = 0; index < 128; index += 1) {
      const replacement = coordinator.replaceRootsOwner({}, () => ({
        roots: [{ uri: `file:///distinct-${index}` }],
      }))!;
      coordinator.commitRootsOwner(replacement);
    }
    expect(retainedRootsGenerations(coordinator)).toBe(1);
    await expect(rootsList()).resolves.toEqual({
      roots: [{ uri: "file:///distinct-127" }],
    });
  }

  {
    const { coordinator, rootsList } = makeCoordinator();
    const owner = {};
    for (let index = 0; index < 128; index += 1) {
      const replacement = coordinator.replaceRootsOwner(owner, () => ({
        roots: [{ uri: `file:///same-owner-${index}` }],
      }))!;
      coordinator.commitRootsOwner(replacement);
    }
    expect(retainedRootsGenerations(coordinator)).toBe(1);
    await expect(rootsList()).resolves.toEqual({
      roots: [{ uri: "file:///same-owner-127" }],
    });
  }

  {
    const { coordinator, rootsList } = makeCoordinator();
    const stalled = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///stalled" }],
    }))!;
    for (let index = 0; index < 128; index += 1) {
      const replacement = coordinator.replaceRootsOwner({}, () => ({
        roots: [{ uri: `file:///success-${index}` }],
      }))!;
      coordinator.commitRootsOwner(replacement);
      expect(retainedRootsGenerations(coordinator)).toBe(1);
    }
    expect(retainedRootsGenerations(coordinator)).toBe(1);
    await expect(rootsList()).resolves.toEqual({
      roots: [{ uri: "file:///success-127" }],
    });
    coordinator.commitRootsOwner(stalled);
    expect(retainedRootsGenerations(coordinator)).toBe(1);
    await expect(rootsList()).resolves.toEqual({
      roots: [{ uri: "file:///success-127" }],
    });
  }

  {
    const { coordinator, rootsList } = makeCoordinator();
    const stalled = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///stalled" }],
    }))!;
    for (let index = 0; index < 128; index += 1) {
      const replacement = coordinator.replaceRootsOwner({}, () => ({
        roots: [{ uri: `file:///success-${index}` }],
      }))!;
      coordinator.commitRootsOwner(replacement);
      expect(retainedRootsGenerations(coordinator)).toBe(1);
    }
    coordinator.rollbackRootsOwner(stalled);
    expect(retainedRootsGenerations(coordinator)).toBe(1);
    await expect(rootsList()).resolves.toEqual({
      roots: [{ uri: "file:///success-127" }],
    });
  }

  {
    // H committed; A pending; B pending; B fails, then A fails.
    const { coordinator, rootsList } = makeCoordinator();
    const healthy = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///healthy" }],
    }))!;
    coordinator.commitRootsOwner(healthy);
    const first = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///a" }],
    }))!;
    const second = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///b" }],
    }))!;
    coordinator.rollbackRootsOwner(second);
    await expect(rootsList()).resolves.toEqual({ roots: [{ uri: "file:///a" }] });
    coordinator.rollbackRootsOwner(first);
    await expect(rootsList()).resolves.toEqual({ roots: [{ uri: "file:///healthy" }] });
  }

  {
    for (const intermediateCount of [2, 3, 5]) {
      const { coordinator, rootsList } = makeCoordinator();
      const healthy = coordinator.replaceRootsOwner({}, () => ({
        roots: [{ uri: "file:///healthy" }],
      }))!;
      coordinator.commitRootsOwner(healthy);

      const owners = Array.from({ length: intermediateCount }, () => ({}));
      const intermediates = owners.map(
        (owner, index) =>
          coordinator.replaceRootsOwner(owner, () => ({
            roots: [{ uri: `file:///intermediate-${index}` }],
          }))!,
      );
      const pending = coordinator.replaceRootsOwner({}, () => ({
        roots: [{ uri: "file:///pending" }],
      }))!;

      await expect(rootsList()).resolves.toEqual({ roots: [{ uri: "file:///pending" }] });
      for (const replacement of intermediates) coordinator.commitRootsOwner(replacement);
      for (const owner of owners) coordinator.releaseRootsOwner(owner);
      coordinator.rollbackRootsOwner(pending);

      expect(retainedRootsGenerations(coordinator)).toBe(1);
      await expect(rootsList()).resolves.toEqual({ roots: [{ uri: "file:///healthy" }] });
    }
  }

  {
    // A stalled owner must not prevent retaining the latest viable fallback.
    const { coordinator, rootsList } = makeCoordinator();
    const stalled = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///stalled" }],
    }))!;
    for (let index = 0; index < 128; index += 1) {
      const replacement = coordinator.replaceRootsOwner({}, () => ({
        roots: [{ uri: `file:///success-${index}` }],
      }))!;
      coordinator.commitRootsOwner(replacement);
    }
    const pending = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///pending" }],
    }))!;
    coordinator.rollbackRootsOwner(pending);
    await expect(rootsList()).resolves.toEqual({
      roots: [{ uri: "file:///success-127" }],
    });
    coordinator.rollbackRootsOwner(stalled);
  }

  {
    // A released stalled owner cannot be restored by late settlement.
    const { coordinator, rootsList } = makeCoordinator();
    const stalledOwner = {};
    const stalled = coordinator.replaceRootsOwner(stalledOwner, () => ({
      roots: [{ uri: "file:///stalled" }],
    }))!;
    for (let index = 0; index < 128; index += 1) {
      const replacement = coordinator.replaceRootsOwner({}, () => ({
        roots: [{ uri: `file:///success-${index}` }],
      }))!;
      coordinator.commitRootsOwner(replacement);
    }
    coordinator.releaseRootsOwner(stalledOwner);
    expect(retainedRootsGenerations(coordinator)).toBeLessThanOrEqual(3);
    coordinator.commitRootsOwner(stalled);
    expect(retainedRootsGenerations(coordinator)).toBe(1);
    await expect(rootsList()).resolves.toEqual({
      roots: [{ uri: "file:///success-127" }],
    });
  }

  {
    // Closing clears routing permanently, including late settlements.
    const { coordinator, rootsList } = makeCoordinator();
    const stalled = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///stalled" }],
    }))!;
    for (let index = 0; index < 128; index += 1) {
      const replacement = coordinator.replaceRootsOwner({}, () => ({
        roots: [{ uri: `file:///success-${index}` }],
      }))!;
      coordinator.commitRootsOwner(replacement);
    }
    await coordinator.close();
    coordinator.commitRootsOwner(stalled);
    coordinator.rollbackRootsOwner(stalled);
    expect(retainedRootsGenerations(coordinator)).toBe(0);
    await expectNoRootsOwner(rootsList);
  }

  {
    // H committed; A and B pending; A commits; release A; B fails.
    const { coordinator, rootsList } = makeCoordinator();
    const healthy = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///healthy" }],
    }))!;
    coordinator.commitRootsOwner(healthy);
    const firstOwner = {};
    const first = coordinator.replaceRootsOwner(firstOwner, () => ({
      roots: [{ uri: "file:///a" }],
    }))!;
    const second = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///b" }],
    }))!;
    await expect(rootsList()).resolves.toEqual({ roots: [{ uri: "file:///b" }] });
    coordinator.commitRootsOwner(first);
    coordinator.releaseRootsOwner(firstOwner);
    coordinator.rollbackRootsOwner(second);
    expect(retainedRootsGenerations(coordinator)).toBe(1);
    await expect(rootsList()).resolves.toEqual({ roots: [{ uri: "file:///healthy" }] });
  }

  {
    // H committed; A and B pending; B commits; A fails.
    const { coordinator, rootsList } = makeCoordinator();
    const healthy = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///healthy" }],
    }))!;
    coordinator.commitRootsOwner(healthy);
    const first = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///a" }],
    }))!;
    const second = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///b" }],
    }))!;
    await expect(rootsList()).resolves.toEqual({ roots: [{ uri: "file:///b" }] });
    coordinator.commitRootsOwner(second);
    coordinator.rollbackRootsOwner(first);
    expect(retainedRootsGenerations(coordinator)).toBe(1);
    await expect(rootsList()).resolves.toEqual({ roots: [{ uri: "file:///b" }] });
  }

  {
    // H committed; A and B pending; A fails; B fails.
    const { coordinator, rootsList } = makeCoordinator();
    const healthy = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///healthy" }],
    }))!;
    coordinator.commitRootsOwner(healthy);
    const first = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///a" }],
    }))!;
    const second = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///b" }],
    }))!;
    await expect(rootsList()).resolves.toEqual({ roots: [{ uri: "file:///b" }] });
    coordinator.rollbackRootsOwner(first);
    coordinator.rollbackRootsOwner(second);
    expect(retainedRootsGenerations(coordinator)).toBe(1);
    await expect(rootsList()).resolves.toEqual({ roots: [{ uri: "file:///healthy" }] });
  }

  {
    // H committed; A pending; release H; A fails.
    const { coordinator, rootsList } = makeCoordinator();
    const healthyOwner = {};
    const healthy = coordinator.replaceRootsOwner(healthyOwner, () => ({
      roots: [{ uri: "file:///healthy" }],
    }))!;
    coordinator.commitRootsOwner(healthy);
    const first = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///a" }],
    }))!;
    await expect(rootsList()).resolves.toEqual({ roots: [{ uri: "file:///a" }] });
    coordinator.releaseRootsOwner(healthyOwner);
    coordinator.rollbackRootsOwner(first);
    expect(retainedRootsGenerations(coordinator)).toBe(0);
    await expectNoRootsOwner(rootsList);
  }

  {
    // H committed; A pending; close; settle A by commit and then duplicate rollback.
    const { coordinator, rootsList } = makeCoordinator();
    const healthy = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///healthy" }],
    }))!;
    coordinator.commitRootsOwner(healthy);
    const first = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///a" }],
    }))!;
    await expect(rootsList()).resolves.toEqual({ roots: [{ uri: "file:///a" }] });
    await coordinator.close();
    coordinator.commitRootsOwner(first);
    coordinator.rollbackRootsOwner(first);
    expect(retainedRootsGenerations(coordinator)).toBe(0);
    await expectNoRootsOwner(rootsList);
  }

  {
    const { coordinator, rootsList } = makeCoordinator();
    const first = coordinator.replaceRootsOwner({}, () => ({ roots: [{ uri: "file:///a" }] }))!;
    const second = coordinator.replaceRootsOwner({}, () => ({ roots: [{ uri: "file:///b" }] }))!;
    coordinator.rollbackRootsOwner(first);
    coordinator.rollbackRootsOwner(second);
    await expectNoRootsOwner(rootsList);
  }

  {
    const { coordinator, rootsList } = makeCoordinator();
    const first = coordinator.replaceRootsOwner({}, () => ({ roots: [{ uri: "file:///a" }] }))!;
    const second = coordinator.replaceRootsOwner({}, () => ({ roots: [{ uri: "file:///b" }] }))!;
    coordinator.rollbackRootsOwner(second);
    coordinator.rollbackRootsOwner(first);
    await expectNoRootsOwner(rootsList);
  }

  {
    const { coordinator, rootsList } = makeCoordinator();
    const owner = {};
    const first = coordinator.replaceRootsOwner(owner, () => ({ roots: [{ uri: "file:///a1" }] }))!;
    const second = coordinator.replaceRootsOwner(owner, () => ({
      roots: [{ uri: "file:///a2" }],
    }))!;
    coordinator.rollbackRootsOwner(first);
    coordinator.rollbackRootsOwner(second);
    await expectNoRootsOwner(rootsList);
  }

  {
    const { coordinator, rootsList } = makeCoordinator();
    const healthy = coordinator.replaceRootsOwner({}, () => ({
      roots: [{ uri: "file:///healthy" }],
    }))!;
    coordinator.commitRootsOwner(healthy);
    const firstOwner = {};
    const first = coordinator.replaceRootsOwner(firstOwner, () => ({
      roots: [{ uri: "file:///a" }],
    }))!;
    const second = coordinator.replaceRootsOwner({}, () => ({ roots: [{ uri: "file:///b" }] }))!;
    coordinator.releaseRootsOwner(firstOwner);
    coordinator.rollbackRootsOwner(first);
    coordinator.rollbackRootsOwner(second);
    await expect(rootsList()).resolves.toEqual({ roots: [{ uri: "file:///healthy" }] });
  }

  {
    const { coordinator, rootsList } = makeCoordinator();
    const first = coordinator.replaceRootsOwner({}, () => ({ roots: [{ uri: "file:///a" }] }))!;
    const secondOwner = {};
    const second = coordinator.replaceRootsOwner(secondOwner, () => ({
      roots: [{ uri: "file:///b" }],
    }))!;
    coordinator.releaseRootsOwner(secondOwner);
    coordinator.rollbackRootsOwner(first);
    coordinator.rollbackRootsOwner(second);
    await expectNoRootsOwner(rootsList);
  }

  {
    const { coordinator, rootsList } = makeCoordinator();
    const first = coordinator.replaceRootsOwner({}, () => ({ roots: [{ uri: "file:///a" }] }))!;
    const second = coordinator.replaceRootsOwner({}, () => ({ roots: [{ uri: "file:///b" }] }))!;
    await coordinator.close();
    coordinator.commitRootsOwner(first);
    coordinator.rollbackRootsOwner(first);
    coordinator.commitRootsOwner(second);
    coordinator.rollbackRootsOwner(second);
    await expectNoRootsOwner(rootsList);
  }

  {
    const { coordinator, rootsList } = makeCoordinator();
    const first = coordinator.replaceRootsOwner({}, () => ({ roots: [{ uri: "file:///a" }] }))!;
    const second = coordinator.replaceRootsOwner({}, () => ({ roots: [{ uri: "file:///b" }] }))!;
    coordinator.rollbackRootsOwner(first);
    coordinator.commitRootsOwner(second);
    await expect(rootsList()).resolves.toEqual({ roots: [{ uri: "file:///b" }] });
  }
});
