import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as NodeStream from "node:stream";

const server = new Server(
  { name: "task1-legacy", version: "1" },
  {
    supportedProtocolVersions: ["2025-11-25"],
  },
);
server.registerCapabilities({
  tools: {},
  prompts: {},
  resources: { subscribe: true, listChanged: true },
});
const resources = new Set();
server.setRequestHandler("resources/list", () => ({ resources: [] }));
server.setRequestHandler("prompts/list", () => ({ prompts: [] }));
server.setRequestHandler("prompts/get", async (request, context) => {
  if (request.params.name !== "needs-roots-prompt") return { messages: [] };
  const result = await context.mcpReq.send(
    { method: "roots/list" },
    { signal: context.mcpReq.signal },
  );
  return { description: result.roots[0].uri, messages: [] };
});
server.setRequestHandler("resources/read", async (request, context) => {
  if (request.params.uri !== "file:///needs-roots-resource") return { contents: [] };
  const result = await context.mcpReq.send(
    { method: "roots/list" },
    { signal: context.mcpReq.signal },
  );
  return { contents: [{ uri: request.params.uri, text: result.roots[0].uri }] };
});
server.setRequestHandler("resources/subscribe", (request) => {
  resources.add(request.params.uri);
  return {};
});
server.setRequestHandler("resources/unsubscribe", (request) => {
  resources.delete(request.params.uri);
  return {};
});
let invocations = 0;
server.setRequestHandler("tools/list", () => ({ tools: [] }));
server.setRequestHandler("tools/call", async (request, context) => {
  if (request.params.name === "subscriptions")
    return { content: [{ type: "text", text: String(resources.size) }] };
  if (request.params.name === "emit") {
    for (const uri of resources) await server.sendResourceUpdated({ uri });
    return { content: [] };
  }
  if (request.params.name === "count") {
    return { content: [{ type: "text", text: String(invocations) }] };
  }
  if (request.params.name === "progress") {
    await context.mcpReq.notify({
      method: "notifications/progress",
      params: {
        progressToken: request.params._meta.progressToken,
        progress: 1,
        message: request.params.arguments.label,
      },
    });
    return { content: [] };
  }
  invocations += 1;
  if (request.params.name === "sampling" || request.params.name === "elicitation") {
    const result = await context.mcpReq.send(
      request.params.name === "sampling"
        ? {
            method: "sampling/createMessage",
            params: {
              messages: [{ role: "user", content: { type: "text", text: "fixture" } }],
              maxTokens: 1,
            },
          }
        : {
            method: "elicitation/create",
            params: {
              mode: "form",
              message: "fixture",
              requestedSchema: { type: "object", properties: {} },
            },
          },
      { signal: context.mcpReq.signal },
    );
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
  const ask = () =>
    context.mcpReq.send({ method: "roots/list" }, { signal: context.mcpReq.signal });
  const result =
    request.params.name === "parallel" ? (await Promise.all([ask(), ask()]))[1] : await ask();
  if (request.params._meta?.progressToken !== undefined)
    await context.mcpReq.notify({
      method: "notifications/progress",
      params: {
        progressToken: request.params._meta.progressToken,
        progress: 1,
        message: result.roots[0].uri,
      },
    });
  return { content: [{ type: "text", text: result.roots[0].uri }] };
});
// Exercise the real pipe with progress and completion in one OS write.
const pendingProgress = new Map();
const output = new NodeStream.Writable({
  write(chunk, _encoding, callback) {
    const line = chunk.toString();
    const message = JSON.parse(line);
    if (message.method === "notifications/progress") {
      pendingProgress.set(message.params.progressToken, line);
      callback();
      return;
    }
    const progress = pendingProgress.get(message.id) ?? "";
    pendingProgress.delete(message.id);
    process.stdout.write(progress + line, callback);
  },
});
await server.connect(new StdioServerTransport(process.stdin, output));
