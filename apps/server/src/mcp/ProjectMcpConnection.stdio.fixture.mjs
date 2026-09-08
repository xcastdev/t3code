import { Server } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const transport = new StdioServerTransport();
const subscriptions = new Set();
let opened = 0;
serveStdio(
  () => {
    const server = new Server({ name: "modern-notifications", version: "1" });
    server.registerCapabilities({
      tools: { listChanged: true },
      prompts: { listChanged: true },
      resources: { listChanged: true, subscribe: true },
      subscriptions: {},
    });
    server.setRequestHandler("tools/list", () => ({ tools: [] }));
    server.setRequestHandler("prompts/list", () => ({ prompts: [] }));
    server.setRequestHandler("resources/list", () => ({ resources: [] }));
    server.setRequestHandler("tools/call", async (request) => {
      if (request.params.name === "subscriptions")
        return {
          content: [{ type: "text", text: JSON.stringify({ opened, active: subscriptions.size }) }],
        };
      await server.sendToolListChanged();
      await server.sendPromptListChanged();
      await server.sendResourceListChanged();
      await server.sendResourceUpdated({ uri: "file:///fixture" });
      return { content: [] };
    });
    return server;
  },
  { transport },
);
const receive = transport.onmessage;
// MCP Transport exposes a callback property, not EventTarget.addEventListener.
// eslint-disable-next-line unicorn/prefer-add-event-listener
transport.onmessage = (message, extra) => {
  if (message.method === "subscriptions/listen") {
    opened += 1;
    subscriptions.add(message.id);
  }
  if (message.method === "notifications/cancelled") subscriptions.delete(message.params.requestId);
  receive(message, extra);
};
