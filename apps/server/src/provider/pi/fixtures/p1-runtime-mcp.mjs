import * as NodeFSP from "node:fs/promises";
import * as NodeReadline from "node:readline";
const [auditPath] = process.argv.slice(2);
await NodeFSP.writeFile(auditPath + ".pid", String(process.pid));
for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "p1-trusted", version: "1" },
      };
      break;
    case "tools/list":
      result = {
        tools: ["read_assignment", "publish_assignment"].map((name) => ({
          name,
          description: name,
          inputSchema: { type: "object", properties: {} },
        })),
      };
      break;
    case "tools/call": {
      // The investigator binding is server-owned, independent of tool exposure.
      const allowed = request.params.name === "read_assignment";
      await NodeFSP.appendFile(
        auditPath,
        JSON.stringify({ tool: request.params.name, allowed }) + "\n",
      );
      result = {
        content: [
          {
            type: "text",
            text: allowed ? "assignment-read" : "ROLE_DENIED: investigator cannot publish",
          },
        ],
        isError: !allowed,
      };
      break;
    }
    case "ping":
      result = {};
      break;
    default:
      throw new Error(`Unexpected MCP method ${request.method}`);
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
