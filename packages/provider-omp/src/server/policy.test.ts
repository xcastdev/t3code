import { expect, it } from "vite-plus/test";
import { createPolicyEpoch } from "./policy.ts";
import { ownedPolicyManifest, validateRuntimeConfig } from "./runtimeOptions.ts";
it("requires the complete owned policy manifest after options and refuses mode/config replacement", () => {
  const config = {
    cwd: "/work",
    agentDir: "/agent",
    mode: "approval-required",
    environment: "e",
    project: "p",
    providerSession: "s",
    credentialPath: "/private/credential",
    policyManifest: structuredClone(ownedPolicyManifest),
  };
  expect(validateRuntimeConfig(config)).toBe(config);
  for (const patch of [
    { policyManifest: undefined },
    { mode: "yolo" },
    { cwd: "relative" },
    { credentialPath: "relative" },
    { policyManifest: { ...ownedPolicyManifest, autoApprove: true } },
    { policyManifest: { ...ownedPolicyManifest, guards: ownedPolicyManifest.guards.slice(1) } },
  ])
    expect(() => validateRuntimeConfig({ ...config, ...patch })).toThrow();
});
it("invalidates an authoritative policy change and admits a fresh epoch from the new authority, retaining explicit deny/prompt", () => {
  const settings = {};
  const authority = { policy: { write: "allow", read: "prompt", exec: "deny" } };
  const scope = {
    providerSession: "s",
    environment: "e",
    project: "p",
    session: "native",
    cwd: "/work",
    agentDir: "/agent",
    generation: 1,
  };
  const first = createPolicyEpoch({
    settings,
    authority,
    scope,
    readPolicy: () => authority.policy,
  });
  first.open();
  first.assert();
  authority.policy.write = "deny";
  expect(() => first.assert()).toThrow(/policy changed/);
  expect(first.signal.aborted).toBe(true);
  const second = createPolicyEpoch({
    settings: {},
    authority,
    scope: { ...scope, generation: 2 },
    readPolicy: () => authority.policy,
  });
  second.open();
  second.assert();
  expect(authority.policy).toEqual({ write: "deny", read: "prompt", exec: "deny" });
  expect(() => first.open()).toThrow(/closed/);
  first.dispose();
  second.dispose();
});

it("closes admission on a configuration read failure and never repairs the old epoch", () => {
  let broken = false;
  const epoch = createPolicyEpoch({
    settings: {},
    authority: {},
    scope: {
      providerSession: "s",
      environment: "e",
      project: "p",
      session: "n",
      cwd: "/work",
      agentDir: "/agent",
      generation: 1,
    },
    readPolicy: () => {
      if (broken) throw new Error("config reload failed");
      return { policy: "prompt" };
    },
  });
  epoch.open();
  broken = true;
  expect(() => epoch.assert()).toThrow(/config reload failed/);
  expect(epoch.signal.aborted).toBe(true);
  broken = false;
  expect(() => epoch.assert()).toThrow(/closed/);
  epoch.dispose();
});
