// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
import { createPolicyEpoch, normalizeOmpMode } from "./policy.ts";
import { enterNativeCall, captureAuthorization, assertBeforeInvoke } from "./runtimePolicyHooks.ts";

function setup() {
  const settings = {};
  const scope = {
    providerSession: "proof",
    environment: "e",
    project: "p",
    session: "s",
    cwd: "/work",
    agentDir: "/agent",
    generation: 1,
  };
  const epoch = createPolicyEpoch({
    settings,
    authority: {},
    scope,
    readPolicy: () => ({ mode: "always-ask" }),
  });
  return { settings, scope, epoch };
}
describe("native permission lifetime", () => {
  it("keeps admission closed until acknowledged and refuses stale or unregistered settings", () => {
    const s = setup();
    const call = () =>
      enterNativeCall(s.settings, { nativeCallId: "a", kind: "tool", scope: s.scope });
    expect(call).toThrow(/closed/);
    s.epoch.open();
    expect(call).not.toThrow();
    expect(() => enterNativeCall({}, { nativeCallId: "b", kind: "tool", scope: s.scope })).toThrow(
      /unregistered/,
    );
    s.epoch.invalidate("revoked");
    expect(call).toThrow(/closed/);
  });
  it("rejects nested input mutation and returns separately owned invocation arguments", () => {
    const s = setup();
    s.epoch.open();
    const subject = { name: "write" };
    const input = { path: "relative", nested: { content: "approved" }, unknownField: [1] };
    const token = enterNativeCall(s.settings, { nativeCallId: "a", kind: "tool", scope: s.scope });
    const auth = captureAuthorization(token, {
      subject,
      effectiveInput: input,
      executionContext: {},
      disposition: "once",
      decision: { mode: "yolo", decision: { policy: "allow", tier: "write" } },
      resolveDecision: () => ({ mode: "yolo", decision: { policy: "allow", tier: "write" } }),
    });
    const invocation = assertBeforeInvoke(auth, {
      settings: s.settings,
      subject,
      effectiveInput: input,
      executionContext: {},
      scope: s.scope,
    });
    expect(invocation).toEqual(input);
    expect(invocation).not.toBe(input);
    const freshToken = enterNativeCall(s.settings, {
      nativeCallId: "b",
      kind: "tool",
      scope: s.scope,
    });
    const fresh = captureAuthorization(freshToken, {
      subject,
      effectiveInput: input,
      executionContext: {},
      disposition: "once",
      decision: { mode: "yolo", decision: { policy: "allow", tier: "write" } },
      resolveDecision: () => ({ mode: "yolo", decision: { policy: "allow", tier: "write" } }),
    });
    input.nested.content = "changed";
    expect(() =>
      assertBeforeInvoke(fresh, {
        settings: s.settings,
        subject,
        effectiveInput: input,
        executionContext: {},
        scope: s.scope,
      }),
    ).toThrow(/changed/);
  });
  it("normalizes persisted Auto to a displayed supervised mode", () => {
    expect(normalizeOmpMode("auto")).toEqual({ mode: "approval-required", native: "always-ask" });
    expect(normalizeOmpMode("auto-accept-edits").native).toBe("write");
    expect(normalizeOmpMode("full-access").native).toBe("yolo");
  });
});
