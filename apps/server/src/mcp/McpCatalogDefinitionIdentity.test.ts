import {
  ProjectMcpCredentialId,
  ProjectMcpEnvironmentVariableName,
  ProjectMcpHeaderName,
  type ProjectMcpTransport,
  type ProjectMcpTransportDraft,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { hasCatalogTransportIdentityChange } from "./McpCatalogDefinitionIdentity.ts";

const credentialId = (value: string) => ProjectMcpCredentialId.make(value);
const environmentName = (value: string) => ProjectMcpEnvironmentVariableName.make(value);
const headerName = (value: string) => ProjectMcpHeaderName.make(value);

const stdio: ProjectMcpTransport = {
  type: "stdio",
  command: "node",
  args: ["server.mjs", "--stdio"],
  cwd: "/workspace",
  env: [
    {
      name: environmentName("TOKEN"),
      credential: { id: credentialId("11111111-1111-4111-8111-111111111111"), name: "Token" },
    },
  ],
};

const stdioDraft = (
  overrides: Partial<Extract<ProjectMcpTransportDraft, { type: "stdio" }>> = {},
) => ({
  type: "stdio" as const,
  command: "node",
  args: ["server.mjs", "--stdio"],
  cwd: "/workspace",
  env: [
    {
      name: environmentName("TOKEN"),
      credential: {
        id: credentialId("11111111-1111-4111-8111-111111111111"),
        name: "Renamed token",
      },
    },
  ],
  ...overrides,
});

const oauth: ProjectMcpTransport = {
  type: "streamable-http",
  url: "https://example.test/mcp",
  headers: [],
  authorization: {
    type: "oauth",
    registration: {
      type: "pre-registered",
      clientId: "client-a",
      clientSecret: {
        id: credentialId("22222222-2222-4222-8222-222222222222"),
        name: "Client secret",
      },
    },
  },
};

const oauthDraft = (
  overrides: Partial<Extract<ProjectMcpTransportDraft, { type: "streamable-http" }>> = {},
) => ({
  type: "streamable-http" as const,
  url: "https://example.test/mcp",
  headers: [],
  authorization: {
    type: "oauth" as const,
    registration: {
      type: "pre-registered" as const,
      clientId: "client-a",
      clientSecret: {
        id: credentialId("22222222-2222-4222-8222-222222222222"),
        name: "Renamed secret",
      },
    },
  },
  ...overrides,
});

it("retains identity for metadata and unchanged credential references", () => {
  expect(hasCatalogTransportIdentityChange(stdio, stdioDraft())).toBe(false);
  expect(
    hasCatalogTransportIdentityChange(stdio, {
      ...stdioDraft(),
      env: [
        {
          ...stdioDraft().env[0]!,
          credential: { ...stdioDraft().env[0]!.credential, name: "Display only" },
        },
      ],
    }),
  ).toBe(false);
});

it.each([
  ["command", { command: "bun" }],
  ["arguments", { args: ["server.mjs", "--other"] }],
  ["working directory", { cwd: "/other" }],
  ["environment name", { env: [{ ...stdioDraft().env[0]!, name: environmentName("OTHER") }] }],
  [
    "credential reference",
    {
      env: [
        {
          ...stdioDraft().env[0]!,
          credential: { id: credentialId("33333333-3333-4333-8333-333333333333"), name: "Token" },
        },
      ],
    },
  ],
  [
    "new credential value",
    {
      env: [
        {
          ...stdioDraft().env[0]!,
          credential: { ...stdioDraft().env[0]!.credential, value: "new" },
        },
      ],
    },
  ],
  [
    "empty credential value",
    {
      env: [
        { ...stdioDraft().env[0]!, credential: { ...stdioDraft().env[0]!.credential, value: "" } },
      ],
    },
  ],
] as const)("rotates identity for stdio %s changes", (_name, change) => {
  expect(hasCatalogTransportIdentityChange(stdio, stdioDraft(change))).toBe(true);
});

it("rotates identity for HTTP transport and authorization changes", () => {
  expect(
    hasCatalogTransportIdentityChange(oauth, {
      ...oauthDraft(),
      url: "https://other.example.test/mcp",
    }),
  ).toBe(true);
  expect(
    hasCatalogTransportIdentityChange(oauth, {
      ...oauthDraft(),
      authorization: { type: "none" },
    }),
  ).toBe(true);
  expect(
    hasCatalogTransportIdentityChange(oauth, {
      ...oauthDraft(),
      authorization: {
        type: "oauth",
        registration: { type: "pre-registered", clientId: "client-b" },
      },
    }),
  ).toBe(true);
  expect(
    hasCatalogTransportIdentityChange(oauth, {
      ...oauthDraft(),
      authorization: {
        type: "oauth",
        registration: {
          type: "pre-registered",
          clientId: "client-a",
          clientSecret: { name: "new secret", value: "" },
        },
      },
    }),
  ).toBe(true);
});

it("treats HTTP header order and names as identity-bearing", () => {
  const previous: ProjectMcpTransport = {
    type: "streamable-http",
    url: "https://example.test/mcp",
    headers: [
      {
        name: headerName("X-First"),
        credential: { id: credentialId("44444444-4444-4444-8444-444444444444"), name: "First" },
      },
      {
        name: headerName("X-Second"),
        credential: { id: credentialId("55555555-5555-4555-8555-555555555555"), name: "Second" },
      },
    ],
    authorization: { type: "none" },
  };
  const draft = {
    ...previous,
    headers: [...previous.headers].reverse(),
  } as ProjectMcpTransportDraft;
  expect(hasCatalogTransportIdentityChange(previous, draft)).toBe(true);
});
