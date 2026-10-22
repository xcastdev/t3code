import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { CLIENT_GUARDED_RPC_SCOPES, clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";
import {
  ProjectTerminalAttachSnapshot,
  ProjectTerminalCreateInput,
  ProjectTerminalReadCursorClaims,
  ProjectTerminalWriteInput,
  ProjectTerminalStopResult,
  TerminalReadInput,
} from "./terminalToolkit.ts";

import { DEFAULT_MAX_TERMINAL_BUFFER_BYTES } from "./terminal.ts";

const handle = { projectId: "project-1", terminalId: "shared-1" };

describe("project terminal wire boundaries", () => {
  it("caps attach history by UTF-8 bytes at ASCII, CJK and astral boundaries", () => {
    const decode = Schema.decodeUnknownSync(ProjectTerminalAttachSnapshot);
    const snapshot = {
      terminal: {
        ...handle,
        generation: "run-1",
        creatingThreadId: "thread-1",
        label: "shared",
        status: "running",
        cols: 80,
        rows: 24,
        exitCode: null,
        exitSignal: null,
        updatedAt: "2026-10-21T00:00:00.000Z",
      },
      cols: 80,
      rows: 24,
      sequence: 0,
    };
    for (const character of ["x", "漢", "😀"]) {
      const width = new TextEncoder().encode(character).length;
      const history =
        character.repeat(Math.floor(DEFAULT_MAX_TERMINAL_BUFFER_BYTES / width)) +
        "x".repeat(DEFAULT_MAX_TERMINAL_BUFFER_BYTES % width);
      expect(new TextEncoder().encode(history).length).toBe(DEFAULT_MAX_TERMINAL_BUFFER_BYTES);
      expect(decode({ ...snapshot, history }).history).toBe(history);
      expect(() => decode({ ...snapshot, history: history + "x" })).toThrow();
    }
    expect(() =>
      decode({
        ...snapshot,
        history: "漢".repeat(DEFAULT_MAX_TERMINAL_BUFFER_BYTES),
      }),
    ).toThrow();
  });

  it("rejects launches that cannot be represented as bounded argv", () => {
    const decode = Schema.decodeUnknownSync(ProjectTerminalCreateInput);
    const launch = {
      ...handle,
      creatingThreadId: "thread-1",
      cwd: "/tmp/project",
    };
    expect(() => decode({ ...launch, args: ["orphan"] })).toThrow();
    expect(() => decode({ ...launch, command: "sh\u0000" })).toThrow();
    expect(() =>
      decode({
        ...launch,
        command: "sh",
        args: Array(128).fill("x".repeat(1024)),
      }),
    ).toThrow();
    expect(decode({ ...launch, command: "sh", args: ["-c", "printf hello"] }).projectId).toBe(
      "project-1",
    );
  });

  it("preserves generation preconditions without requiring legacy callers to supply one", () => {
    const decode = Schema.decodeUnknownSync(ProjectTerminalWriteInput);
    expect(decode({ ...handle, data: "x", expectedGeneration: "run-1" }).expectedGeneration).toBe(
      "run-1",
    );
    expect(decode({ ...handle, data: "x" }).expectedGeneration).toBeUndefined();
    expect(() => decode({ ...handle, data: "x", expectedGeneration: "" })).toThrow();
  });

  it("requires cursor reader, generation and expiration claims", () => {
    const decode = Schema.decodeUnknownSync(ProjectTerminalReadCursorClaims);
    const claims = {
      ...handle,
      version: 1,
      readerId: "thread-1:codex",
      generation: "run-1",
      mode: "stream",
      offset: 0,
      expiresAt: "2026-10-21T00:00:00.000Z",
    };
    expect(decode(claims).readerId).toBe("thread-1:codex");
    expect(() => decode({ ...claims, readerId: "" })).toThrow();
    expect(() => decode({ ...claims, generation: undefined })).toThrow();
    expect(() => decode({ ...claims, expiresAt: "invalid" })).toThrow();
    expect(() => decode({ ...claims, offset: -1 })).toThrow();
  });

  it("rejects unbounded and contradictory read requests", () => {
    const decode = Schema.decodeUnknownSync(TerminalReadInput);
    expect(() => decode({ ...handle, cursor: "x".repeat(4097) })).toThrow();
    expect(() => decode({ ...handle, maxBytes: 65_537 })).toThrow();
    expect(() => decode({ ...handle, tailLines: 10, cursor: "cursor" })).toThrow();
    expect(() => decode({ ...handle, search: { text: "error" }, waitMs: 1 })).toThrow();
  });

  it("distinguishes requested stop from observed exit and uncertainty", () => {
    const decode = Schema.decodeUnknownSync(ProjectTerminalStopResult);
    for (const status of ["requested", "exited", "unknown"]) {
      expect(decode({ ...handle, generation: "run-1", status }).status).toBe(status);
    }
    expect(() => decode({ ...handle, generation: "run-1", status: "killed" })).toThrow();
  });

  it("requires terminal operation grants for every project terminal mutation", () => {
    for (const method of [
      WS_METHODS.projectTerminalWrite,
      WS_METHODS.projectTerminalResize,
      WS_METHODS.projectTerminalKill,
    ]) {
      expect(clientRpcRequiredScopes(method, handle)).toEqual(["terminal:operate"]);
    }
  });

  it("requires settings grants for skill deployment and resource overlay changes", () => {
    for (const method of [
      WS_METHODS.skillsDeploymentChange,
      WS_METHODS.skillsSessionReset,
      WS_METHODS.managedTextResourcesEnvironmentCreate,
      WS_METHODS.managedTextResourcesThreadSetEnabled,
      WS_METHODS.managedTextResourcesThreadReset,
    ]) {
      expect(clientRpcRequiredScopes(method, {})).toEqual(["settings:write"]);
      expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)).toBe(true);
    }
  });
});
