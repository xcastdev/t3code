import * as Redacted from "effect/Redacted";
import { expect, it, vi } from "vite-plus/test";

import {
  clearNativeRelayAdmission,
  installNativeRelayAdmission,
  readNativeRelayAdmission,
  readNativeVerifiedRouteBinding,
} from "./relay-admission";
import { enrollVerifiedRoute } from "./verified-route";

const storage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  set: vi.fn<(key: string, value: string) => Promise<void>>(),
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => storage.values.get(key) ?? null,
  setItemAsync: storage.set,
  deleteItemAsync: async (key: string) => {
    storage.values.delete(key);
  },
}));

const enrollmentKey = "t3code.verified-routes.v1";
const policyKey = "t3code.verified-route-policy.v1";
const binding = {
  environmentId: "env",
  httpsOrigin: "https://relay.example.com:8443",
  leafSpkiSha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};
const credential = "test-relay-session";

function setup() {
  storage.values.clear();
  storage.set.mockReset();
  storage.set.mockImplementation(async (key, value) => {
    storage.values.set(key, value);
  });
}

it("persists a separate exact credential binding and refuses missing or changed values", async () => {
  setup();
  await expect(installNativeRelayAdmission(binding, credential)).rejects.toThrow(
    "matching verified route",
  );
  await expect(readNativeVerifiedRouteBinding(binding.httpsOrigin)).resolves.toBeNull();
  await enrollVerifiedRoute(binding);
  expect(storage.set.mock.calls.map(([key]) => key)).toEqual([policyKey, enrollmentKey]);
  await expect(readNativeRelayAdmission(binding)).resolves.toBeNull();
  await expect(readNativeVerifiedRouteBinding(binding.httpsOrigin)).resolves.toEqual({
    ...binding,
    transportRole: "direct",
  });
  for (const other of [
    { ...binding, httpsOrigin: "https://relay.example.com" },
    { ...binding, environmentId: "other" },
    { ...binding, leafSpkiSha256: "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
  ]) {
    await expect(installNativeRelayAdmission(other, credential)).rejects.toThrow(
      "matching verified route",
    );
  }
  await expect(installNativeRelayAdmission(binding, "ambiguous, credential")).rejects.toThrow(
    "Invalid relay admission credential",
  );
  await installNativeRelayAdmission(binding, credential);
  expect(JSON.parse(storage.values.get(enrollmentKey) ?? "null")).toEqual([binding]);
  expect(JSON.parse(storage.values.get(policyKey) ?? "null")).toEqual({
    [binding.httpsOrigin]: "relay",
  });
  const secretKey = [...storage.values.keys()].find((key) =>
    key.startsWith("t3code.relay-admission.v1."),
  )!;
  expect(JSON.parse(storage.values.get(secretKey) ?? "null")).toEqual({ ...binding, credential });
  expect(Redacted.value((await readNativeRelayAdmission(binding))!)).toBe(credential);
  for (const raw of [
    "{bad",
    JSON.stringify({ ...binding, environmentId: "other", credential }),
    JSON.stringify({ ...binding, httpsOrigin: "https://relay.example.com", credential }),
    JSON.stringify({ ...binding, leafSpkiSha256: "wrong-pin", credential }),
    JSON.stringify({ ...binding, credential: "bad\r\nheader" }),
  ]) {
    storage.values.set(secretKey, raw);
    await expect(readNativeRelayAdmission(binding)).rejects.toThrow(
      "Relay admission credential is unavailable.",
    );
  }
  await clearNativeRelayAdmission(binding);
  expect(storage.values.has(secretKey)).toBe(false);
  expect(JSON.parse(storage.values.get(policyKey) ?? "null")).toEqual({
    [binding.httpsOrigin]: "relay",
  });
  await expect(readNativeRelayAdmission(binding)).rejects.toThrow(
    "Relay admission credential is unavailable.",
  );
  await expect(readNativeRelayAdmission({ ...binding, environmentId: "other" })).rejects.toThrow(
    "Verified route enrollment is unavailable.",
  );
});

it("migrates a legacy credential left beside a restored pin-only record before clearing it", async () => {
  setup();
  const legacy = { ...binding, httpsOrigin: "https://legacy-relay.example.com" };
  const secretKey = `t3code.relay-admission.v1.${btoa(legacy.httpsOrigin).replace(/=+$/, "")}`;
  storage.values.set(enrollmentKey, JSON.stringify([legacy]));
  storage.values.set(secretKey, JSON.stringify({ ...legacy, credential }));

  vi.resetModules();
  const admission = await import("./relay-admission");
  await expect(admission.readNativeVerifiedRouteBinding(legacy.httpsOrigin)).resolves.toEqual({
    ...legacy,
    transportRole: "relay",
  });
  await admission.clearNativeRelayAdmission(legacy);
  expect(storage.values.has(secretKey)).toBe(false);
  expect(JSON.parse(storage.values.get(policyKey) ?? "null")).toEqual({
    [legacy.httpsOrigin]: "relay",
  });

  vi.resetModules();
  const coldAdmission = await import("./relay-admission");
  await expect(coldAdmission.readNativeVerifiedRouteBinding(legacy.httpsOrigin)).resolves.toEqual({
    ...legacy,
    transportRole: "relay",
  });
  await expect(coldAdmission.readNativeRelayAdmission(legacy)).rejects.toThrow(
    "Relay admission credential is unavailable.",
  );
});

it("keeps relay admission required in process when SecureStore rejects the policy write", async () => {
  setup();
  vi.resetModules();
  const { enrollVerifiedRoute: enroll } = await import("./verified-route");
  const admission = await import("./relay-admission");
  const pendingBinding = { ...binding, httpsOrigin: "https://unwritten-policy.example.com" };
  storage.set.mockRejectedValueOnce(new Error("SecureStore write failed"));
  await expect(enroll(pendingBinding)).rejects.toThrow("SecureStore write failed");
  expect(storage.values.has(enrollmentKey)).toBe(false);
  await enroll(pendingBinding);
  storage.set.mockRejectedValueOnce(new Error("SecureStore write failed"));
  await expect(admission.installNativeRelayAdmission(pendingBinding, credential)).rejects.toThrow(
    "SecureStore write failed",
  );
  expect([...storage.values.keys()]).toEqual([policyKey, enrollmentKey]);
  await expect(admission.readNativeRelayAdmission(pendingBinding)).rejects.toThrow(
    "Relay admission credential is unavailable.",
  );
});

it("fails closed after a partial install and orders a clear behind in-flight provisioning", async () => {
  setup();
  const partialBinding = { ...binding, httpsOrigin: "https://partial-install.example.com" };
  await enrollVerifiedRoute(partialBinding);
  storage.set.mockImplementationOnce(async (key, value) => {
    storage.values.set(key, value);
  });
  storage.set.mockRejectedValueOnce(new Error(credential));
  await expect(installNativeRelayAdmission(partialBinding, credential)).rejects.toThrow(
    "Unable to save the relay admission credential.",
  );
  await expect(readNativeRelayAdmission(partialBinding)).rejects.toThrow(
    "Relay admission credential is unavailable.",
  );

  const started = Promise.withResolvers<void>();
  const written = Promise.withResolvers<void>();
  storage.set.mockImplementationOnce(async (key, value) => {
    started.resolve();
    await written.promise;
    storage.values.set(key, value);
  });
  const installing = installNativeRelayAdmission(partialBinding, credential);
  await started.promise;
  const clearing = clearNativeRelayAdmission(partialBinding);
  const reading = readNativeRelayAdmission(partialBinding);
  written.resolve();
  await installing;
  await clearing;
  await expect(reading).rejects.toThrow("Relay admission credential is unavailable.");
  expect([...storage.values.keys()]).toEqual([policyKey, enrollmentKey]);
});
