import * as NodeModule from "node:module";
import { expect, it } from "@effect/vitest";
import {
  Client,
  type JSONRPCMessage,
  type Transport,
  type Progress,
} from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";

const require = NodeModule.createRequire(import.meta.url);
const cjsClient: typeof import("@modelcontextprotocol/client") = require("@modelcontextprotocol/client");
const cjsServer: typeof import("@modelcontextprotocol/server") = require("@modelcontextprotocol/server");

const builds = [
  {
    name: "client ESM",
    create: () =>
      new Client({ name: "fixture", version: "1" }, { versionNegotiation: { mode: "legacy" } }),
  },
  {
    name: "client CJS",
    create: () =>
      new cjsClient.Client(
        { name: "fixture", version: "1" },
        { versionNegotiation: { mode: "legacy" } },
      ),
  },
  { name: "server ESM", create: () => new Server({ name: "fixture", version: "1" }) },
  { name: "server CJS", create: () => new cjsServer.Server({ name: "fixture", version: "1" }) },
];

for (const build of builds) {
  const open = async (
    onRequest?: (message: JSONRPCMessage, receive: (message: JSONRPCMessage) => void) => void,
  ) => {
    const peer = build.create();
    const errors: Error[] = [];
    // MCP Protocol exposes callback properties, not EventTarget listeners.
    // eslint-disable-next-line unicorn/prefer-add-event-listener
    peer.onerror = (error) => errors.push(error);
    const wire: Transport = {
      start: async () => undefined,
      close: async () => {
        wire.onclose?.();
      },
      send: async (message) => {
        if (!("method" in message) || !("id" in message)) return;
        if (message.method === "initialize") {
          wire.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              serverInfo: { name: "fixture", version: "1" },
            },
          });
        } else if (onRequest) onRequest(message, (message) => wire.onmessage?.(message));
        else wire.onmessage?.({ jsonrpc: "2.0", id: message.id, result: {} });
      },
    };
    await peer.connect(wire);
    return { peer, wire, errors };
  };

  it(`${build.name} cancels an inbound request with ID zero`, async () => {
    const { peer, wire } = await open();
    const entered = Promise.withResolvers<AbortSignal>();
    const gate = Promise.withResolvers<void>();
    const handler = async (_request: unknown, context: { mcpReq: { signal: AbortSignal } }) => {
      entered.resolve(context.mcpReq.signal);
      await gate.promise;
      return {};
    };
    if (peer instanceof Client || peer instanceof cjsClient.Client)
      peer.setRequestHandler("ping", handler);
    else peer.setRequestHandler("ping", handler);
    try {
      wire.onmessage?.({ jsonrpc: "2.0", method: "ping", id: 0 });
      const signal = await entered.promise;
      wire.onmessage?.({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 0 },
      });
      await peer.ping();
      expect(signal.aborted).toBe(true);
    } finally {
      gate.resolve();
      await peer.close();
    }
  });

  for (const result of ["success", "error"] as const) {
    it(`${build.name} accepts only pre-response progress in one synchronous ${result} batch`, async () => {
      const seen: Progress[] = [];
      const { peer } = await open((request, receive) => {
        if (!("id" in request) || !("params" in request)) throw new Error("Expected a request");
        const progressToken = request.params?._meta?.progressToken;
        const progress = (value: number): JSONRPCMessage => ({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken, progress: value },
        });
        receive(progress(1));
        receive(
          result === "success"
            ? { jsonrpc: "2.0", id: request.id, result: {} }
            : { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "fixture error" } },
        );
        receive(progress(2));
      });
      try {
        const request = peer.request(
          { method: "ping" },
          { onprogress: (value) => seen.push(value) },
        );
        if (result === "success") await request;
        else await expect(request).rejects.toThrow("fixture error");
        expect(seen).toEqual([{ progress: 1 }]);
      } finally {
        await peer.close();
      }
    });
  }

  for (const ending of ["cancel", "close"] as const) {
    it(`${build.name} releases progress callbacks on ${ending}`, async () => {
      const sent = Promise.withResolvers<JSONRPCMessage>();
      const { peer, wire } = await open((request) => sent.resolve(request));
      const seen: Progress[] = [];
      const abort = new AbortController();
      try {
        const pending = peer.request(
          { method: "ping" },
          { signal: abort.signal, onprogress: (value) => seen.push(value) },
        );
        const rejected = expect(pending).rejects.toBeDefined();
        const request = await sent.promise;
        if (ending === "cancel") abort.abort();
        else await peer.close();
        await rejected;
        if (!("params" in request)) throw new Error("Expected request params");
        wire.onmessage?.({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: request.params?._meta?.progressToken, progress: 1 },
        });
        await Promise.resolve();
        expect(seen).toEqual([]);
      } finally {
        await peer.close();
      }
    });
  }
}
