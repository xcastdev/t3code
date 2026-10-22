import { describe, expect, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { McpCatalogWriteInput, McpCatalogSecretPrepareInput } from "./mcpCatalog.ts";
const accepts = Schema.is(McpCatalogWriteInput);
const decodePreparedSecret = Schema.decodeUnknownSync(McpCatalogSecretPrepareInput);
const input = (credential: unknown) => ({
  scope: "project",
  scopeId: "project",
  expectedRevision: 0,
  operation: {
    type: "create",
    definition: {
      name: "Docs",
      enabled: true,
      providerInstanceIds: ["codex"],
      transport: {
        type: "streamable-http",
        url: "https://example.test/mcp",
        headers: [{ name: "Authorization", credential }],
        authorization: { type: "none" },
      },
    },
  },
});
describe("P7 public catalog credential custody", () => {
  it("accepts a one-use secret ref and rejects raw credential bytes even alongside retained ids", () => {
    expect(accepts(input({ name: "Token", secretRef: "secret-reference" }))).toBe(true);
    expect(accepts(input({ name: "Token", value: "raw-token" }))).toBe(false);
    expect(
      accepts(
        input({ name: "Token", id: "00000000-0000-4000-8000-000000000001", value: "raw-token" }),
      ),
    ).toBe(false);
  });
  it("rejects unbounded names, URL credentials, and query-bearing transports", () => {
    const draft = input({ name: "Token", secretRef: "secret-reference" });
    expect(
      accepts({
        ...draft,
        operation: {
          ...draft.operation,
          definition: { ...draft.operation.definition, name: "x".repeat(121) },
        },
      }),
    ).toBe(false);
    for (const url of [
      "https://user:pass@example.test/mcp",
      "https://example.test/mcp?secret=value",
      "http://remote.example.test/mcp",
    ]) {
      expect(
        accepts({
          ...draft,
          operation: {
            ...draft.operation,
            definition: {
              ...draft.operation.definition,
              transport: { ...draft.operation.definition.transport, url },
            },
          },
        }),
      ).toBe(false);
    }
  });
});

it("keeps Settings input redacted in diagnostics and catalog writes reference-only", () => {
  const prepared = decodePreparedSecret({
    scope: "global",
    scopeId: "environment",
    expectedRevision: 0,
    logicalServerId: "server",
    secret: "private-secret",
  });
  expect(Redacted.value(prepared.secret)).toBe("private-secret");
  expect(JSON.stringify(prepared)).not.toContain("private-secret");
  expect(accepts(input({ name: "Token", value: "private-secret", secretRef: "ref" }))).toBe(false);
});

it("does not echo secret bytes when Settings input validation fails", () => {
  const secret = "private-validation-marker".repeat(3000);
  try {
    decodePreparedSecret({
      scope: "global",
      scopeId: "environment",
      expectedRevision: 0,
      logicalServerId: "server",
      secret,
    });
    throw new Error("Expected secret length validation to fail");
  } catch (error) {
    expect(String(error)).toContain("Secret must contain");
    expect(String(error)).not.toContain("private-validation-marker");
  }
});
