import { McpServerId, ProjectMcpManagedServer, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { applicationLabel, canEdit } from "./ProjectMcpSettings";

const managedEntry = Schema.decodeUnknownSync(ProjectMcpManagedServer)({
  id: McpServerId.make("t3-code"),
  name: "t3-code",
  url: "http://127.0.0.1:8787/mcp",
  providerInstanceIds: [ProviderInstanceId.make("codex")],
});

describe("ProjectMcpSettings helpers", () => {
  it("labels next-session support honestly", () => {
    expect(applicationLabel("next-session")).toBe("Applies to new sessions");
  });

  it("does not expose mutation controls for a managed entry", () => {
    expect(canEdit(managedEntry)).toBe(false);
  });
});
