// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createPolicyEpoch, fixedOmpPolicy, normalizeOmpMode, type PolicyScope } from "./policy.ts";
import { assertAcknowledged } from "./runtimePolicyHooks.ts";
import { requiredGuards } from "./compatibility.ts";

export const importNative = (root: string, name: string) =>
  import(NodeURL.pathToFileURL(`${root}/src/${name}.ts`).href);

export async function constrainNativeSettings(
  root: string,
  authority: Settings,
  runtimeMode: string,
  scope: PolicyScope,
) {
  await importNative(root, "config/all-settings");
  const registry = (await importNative(
    root,
    "config/registry",
  )) as typeof import("@oh-my-pi/pi-coding-agent/config/registry");
  const keys = [
    "tools.approval",
    "tools.approvalMode",
    "tools.restrictedFolders",
    ...Object.keys(fixedOmpPolicy),
  ];
  const handles = keys.map((key) => {
    const handle = registry.lookup(key);
    if (!handle) throw new Error(`Unsupported OMP setting identity: ${key}`);
    return handle;
  });
  const mode = normalizeOmpMode(runtimeMode);
  const policies = registry.lookup("tools.approval")!.get(authority) as Record<string, unknown>;
  const mask = Object.fromEntries(
    Object.entries(policies)
      .filter(([, value]) => value === "allow")
      .map(([key]) => [key, null]),
  );
  const settings = authority.overlay({
    ...fixedOmpPolicy,
    "tools.approvalMode": mode.native,
    "tools.approval": mask,
  });
  const epoch = createPolicyEpoch({
    settings,
    authority,
    scope: {
      ...scope,
      cwd: NodePath.resolve(scope.cwd),
      agentDir: NodePath.resolve(scope.agentDir),
    },
    readPolicy: () => ({
      authority: handles.map((handle) => handle.get(authority)),
      overlay: handles.map((handle) => handle.get(settings)),
      cwd: settings.getCwd(),
      agentDir: settings.getAgentDir(),
    }),
  });
  const removeAuthority = authority.onEffectiveChange(handles, () =>
    epoch.invalidate("authoritative policy changed"),
  );
  const removeOverlay = settings.onEffectiveChange(handles, () =>
    epoch.invalidate("constrained settings mutated"),
  );
  return {
    settings,
    epoch,
    mode,
    dispose() {
      epoch.dispose();
      removeAuthority();
      removeOverlay();
      settings.cancelPendingSaves();
    },
  };
}

export function acknowledgeRuntime() {
  assertAcknowledged(requiredGuards);
}
