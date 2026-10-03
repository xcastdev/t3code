import { describe, expect, it } from "vite-plus/test";
import { PiSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("derives only the native Pi configuration field from shared settings", () => {
    const pi = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("piAgent")];
    expect(pi).toBeDefined();

    expect(deriveProviderSettingsFields(pi!)).toEqual([
      {
        key: "agentDirectory",
        label: "Pi configuration directory",
        description: "Directory containing this instance's native Pi settings.",
        placeholder: "~/.pi/agent",
        control: "text",
        clearWhenEmpty: "omit",
        targetable: false,
      },
    ]);
  });

  it("edits and clears Pi configuration through the generic form helpers", () => {
    const pi = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("piAgent")];
    expect(pi).toBeDefined();
    const field = deriveProviderSettingsFields(pi!)[0]!;
    const decode = Schema.decodeUnknownSync(PiSettings);

    const configured = nextProviderConfigWithFieldValue(undefined, field, "/trusted/pi");
    expect(decode(configured)).toEqual({ agentDirectory: "/trusted/pi" });

    const cleared = nextProviderConfigWithFieldValue(configured, field, "   ");
    expect(cleared).toBeUndefined();
    expect(decode(cleared ?? {})).toEqual({});
    expect(nextProviderConfigWithFieldValue({ ...configured, forkOwned: 1 }, field, "")).toEqual({
      forkOwned: 1,
    });
  });

  it("keeps Pi form drafts subject to shared configuration validation", () => {
    const pi = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("piAgent")];
    expect(pi).toBeDefined();
    const field = deriveProviderSettingsFields(pi!)[0]!;
    const decode = Schema.decodeUnknownSync(PiSettings);

    expect(decode(nextProviderConfigWithFieldValue(undefined, field, "~/.pi/agent"))).toEqual({
      agentDirectory: "~/.pi/agent",
    });
    for (const value of [" /trusted/pi", "/trusted/pi ", "/trusted/pi\0other", "x".repeat(4097)]) {
      expect(() => decode(nextProviderConfigWithFieldValue(undefined, field, value))).toThrow();
    }
    const withAuthority = nextProviderConfigWithFieldValue(
      { runtimeGrant: true },
      field,
      "/trusted/pi",
    );
    expect(() => decode(withAuthority)).toThrow();
  });

  it("derives visible provider config fields from the client definition schema", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")];

    expect(codex).toBeDefined();
    expect(deriveProviderSettingsFields(codex!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "shadowHomePath",
      "launchArgs",
    ]);
  });

  it("sources labels and descriptions from schema annotations", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverPassword = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverPassword",
    );

    expect(serverPassword).toMatchObject({
      label: "Server password",
      description: "Stored in plain text on disk.",
      control: "password",
    });
  });

  it("exposes external OpenCode MCP controls from schema annotations", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    expect(deriveProviderSettingsFields(opencode!).map((field) => field.key)).toEqual([
      "binaryPath",
      "serverUrl",
      "serverPassword",
      "manageExternalMcp",
      "externalMcpBaseUrl",
    ]);
    expect(
      deriveProviderSettingsFields(opencode!).find((field) => field.key === "manageExternalMcp"),
    ).toMatchObject({
      label: "Manage MCP servers on external OpenCode",
      control: "switch",
      defaultBooleanValue: false,
      targetable: true,
    });
    expect(
      deriveProviderSettingsFields(opencode!).find((field) => field.key === "externalMcpBaseUrl"),
    ).toMatchObject({
      label: "T3 MCP public origin",
      control: "text",
      placeholder: "https://t3.example.com",
    });
  });

  it("derives a select control with its choices for the Antigravity sign-in method", () => {
    const antigravity = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("antigravity")];
    expect(antigravity).toBeDefined();

    const fields = deriveProviderSettingsFields(antigravity!);
    expect(fields.map((field) => field.key)).toEqual([
      "authMethod",
      "apiKey",
      "gcpProject",
      "gcpLocation",
      "binaryPath",
    ]);
    const authMethod = fields.find((field) => field.key === "authMethod");
    expect(authMethod).toMatchObject({
      control: "select",
      clearWhenEmpty: "omit",
    });
    expect(authMethod?.options?.map((option) => option.value)).toEqual([
      "oauth-personal",
      "oauth-business",
      "gemini-api-key",
      "agent-platform",
    ]);
    expect(fields.find((field) => field.key === "apiKey")?.control).toBe("password");
  });

  it("shows the auto-compaction threshold for Claude providers", () => {
    const claude = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("claudeAgent")];
    expect(claude).toBeDefined();

    expect(deriveProviderSettingsFields(claude!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "autoCompactWindow",
      "launchArgs",
    ]);
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits false boolean fields when clearWhenEmpty is omit", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: true },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: false,
      },
      false,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits true boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: false },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      true,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("preserves false boolean fields when clearWhenEmpty is persist", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "persist",
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });
});
