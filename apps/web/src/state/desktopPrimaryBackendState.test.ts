import { EnvironmentId, type DesktopPrimaryBackendState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopPrimaryBackendStateAtom } from "./desktopPrimaryBackendState";

const managedState: DesktopPrimaryBackendState = { mode: "managed" };
const attachedState: DesktopPrimaryBackendState = {
  mode: "attached",
  httpBaseUrl: "http://127.0.0.1:4773/",
  environmentId: EnvironmentId.make("primary-environment"),
  label: "Workstation",
  bearerExpiresAt: "2099-09-08T18:00:00.000Z",
};

describe("desktopPrimaryBackendState", () => {
  it("loads managed ownership through the desktop bridge", async () => {
    const getPrimaryBackendState = vi.fn(async () => managedState);
    const atom = createDesktopPrimaryBackendStateAtom(() => ({ getPrimaryBackendState }));
    const registry = AtomRegistry.make();
    registry.mount(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.getOrElse(registry.get(atom), () => null)).toEqual(managedState);
    });
    expect(getPrimaryBackendState).toHaveBeenCalledOnce();
    registry.dispose();
  });

  it("exposes attached state without a bearer token", async () => {
    const getPrimaryBackendState = vi.fn(async () => attachedState);
    const atom = createDesktopPrimaryBackendStateAtom(() => ({ getPrimaryBackendState }));
    const registry = AtomRegistry.make();
    registry.mount(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.getOrElse(registry.get(atom), () => null)).toEqual(attachedState);
    });
    expect(AsyncResult.getOrElse(registry.get(atom), () => null)).not.toHaveProperty(
      "encryptedBearerToken",
    );
    registry.dispose();
  });

  it("reports an unavailable bridge as a typed load failure", async () => {
    const atom = createDesktopPrimaryBackendStateAtom(() => undefined);
    const registry = AtomRegistry.make();
    registry.mount(atom);

    await vi.waitFor(() => expect(AsyncResult.isFailure(registry.get(atom))).toBe(true));
    const result = registry.get(atom);
    if (!AsyncResult.isFailure(result)) throw new Error("Expected primary backend load to fail.");
    expect(Cause.squash(result.cause)).toMatchObject({
      _tag: "DesktopPrimaryBackendStateUnavailableError",
    });
    registry.dispose();
  });

  it("preserves the desktop bridge rejection as the load error cause", async () => {
    const cause = new Error("desktop bridge rejected");
    const getPrimaryBackendState = vi.fn(async () => Promise.reject(cause));
    const atom = createDesktopPrimaryBackendStateAtom(() => ({ getPrimaryBackendState }));
    const registry = AtomRegistry.make();
    registry.mount(atom);

    await vi.waitFor(() => expect(AsyncResult.isFailure(registry.get(atom))).toBe(true));
    const result = registry.get(atom);
    if (!AsyncResult.isFailure(result)) throw new Error("Expected primary backend load to fail.");
    expect(Cause.squash(result.cause)).toMatchObject({
      _tag: "DesktopPrimaryBackendStateLoadError",
      cause,
    });
    registry.dispose();
  });

  it("refreshes the atom with the latest desktop ownership state", async () => {
    let currentState: DesktopPrimaryBackendState = managedState;
    const getPrimaryBackendState = vi.fn(async () => currentState);
    const atom = createDesktopPrimaryBackendStateAtom(() => ({ getPrimaryBackendState }));
    const registry = AtomRegistry.make();
    registry.mount(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.getOrElse(registry.get(atom), () => null)).toEqual(managedState);
    });
    currentState = attachedState;
    registry.refresh(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.getOrElse(registry.get(atom), () => null)).toEqual(attachedState);
    });
    expect(getPrimaryBackendState).toHaveBeenCalledTimes(2);
    registry.dispose();
  });
});
