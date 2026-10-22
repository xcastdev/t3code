import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export const connectProjectMcp = async (
  transport: Omit<Transport, "sessionId">,
): Promise<Client> => {
  const client = new Client({ name: "t3-catalog-gateway", version: "1" });
  try {
    await client.connect(transport, { timeout: 15_000 });
    return client;
  } catch {
    await transport.close().catch(() => undefined);
    throw new Error("MCP upstream handshake failed.");
  }
};
