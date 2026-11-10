// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import { registerEpoch, unregisterEpoch } from "./runtimePolicyHooks.ts";

export const fixedOmpPolicy = {
  "async.enabled": false,
  "bash.autoBackground.enabled": false,
  "eval.autoBackground.enabled": false,
  "launch.enabled": false,
  "task.maxRecursionDepth": 0,
  "tools.speculativeExecution.enabled": false,
  "task.speculativeLaunch": false,
} as const;

export function normalizeOmpMode(value: string) {
  switch (value) {
    case "full-access":
      return { mode: "full-access", native: "yolo" } as const;
    case "auto-accept-edits":
      return { mode: "auto-accept-edits", native: "write" } as const;
    case "auto":
    case "approval-required":
      return { mode: "approval-required", native: "always-ask" } as const;
    default:
      throw new Error(`Unsupported OMP permission mode: ${value}`);
  }
}

export interface PolicyScope {
  providerSession: string;
  environment: string;
  project: string;
  session: string;
  cwd: string;
  agentDir: string;
  generation: number;
}

export function createPolicyEpoch(input: {
  settings: object;
  authority: object;
  scope: PolicyScope;
  readPolicy: () => unknown;
}) {
  const captured = structuredClone(input.readPolicy());
  const controller = new AbortController();
  let admission = false;
  const epoch = {
    ...input,
    scope: Object.freeze({ ...input.scope }),
    id: NodeCrypto.randomUUID(),
    signal: controller.signal,
    open() {
      if (controller.signal.aborted) throw new Error("OMP policy epoch closed");
      admission = true;
    },
    invalidate(reason: string) {
      admission = false;
      controller.abort(new Error(reason));
    },
    dispose() {
      epoch.invalidate("epoch disposed");
      unregisterEpoch(epoch);
    },
    assert() {
      if (!admission || controller.signal.aborted) throw new Error("OMP policy admission closed");
      let current: unknown;
      try {
        current = input.readPolicy();
      } catch (error) {
        epoch.invalidate("OMP policy configuration read failed");
        throw error;
      }
      if (!NodeUtil.isDeepStrictEqual(current, captured)) {
        epoch.invalidate("OMP authoritative policy changed");
        throw new Error("OMP authoritative policy changed");
      }
    },
  };
  registerEpoch(epoch);
  return epoch;
}
export type PolicyEpoch = ReturnType<typeof createPolicyEpoch>;
