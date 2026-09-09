import type { ReactElement } from "react";
import {
  EnvironmentId,
  type DesktopBridge,
  type DesktopPrimaryBackendState,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const backendState = vi.hoisted(() => ({
  value: {
    data: { mode: "managed" } as DesktopPrimaryBackendState | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("~/state/desktopPrimaryBackendState", () => ({
  desktopPrimaryBackendStateAtom: Symbol("desktop-primary-backend-state"),
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => backendState.value,
}));

import { PrimaryBackendSettings } from "./PrimaryBackendSettings";

const managedState: DesktopPrimaryBackendState = { mode: "managed" };
const invalidState: DesktopPrimaryBackendState = {
  mode: "invalid-attached",
  reason: "The saved attachment could not be reached.",
};
const attachedState: DesktopPrimaryBackendState = {
  mode: "attached",
  httpBaseUrl: "http://127.0.0.1:4773/",
  environmentId: EnvironmentId.make("primary-environment"),
  label: "Workstation",
  bearerExpiresAt: "2099-09-08T18:00:00.000Z",
};

function makeBridge(): Pick<DesktopBridge, "attachPrimaryBackend" | "useManagedPrimaryBackend"> {
  return {
    attachPrimaryBackend: vi.fn(async () => attachedState),
    useManagedPrimaryBackend: vi.fn(async () => undefined),
  };
}

function renderSettings(
  bridge: Pick<DesktopBridge, "attachPrimaryBackend" | "useManagedPrimaryBackend">,
): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return PrimaryBackendSettings({ bridge: bridge as unknown as DesktopBridge }) as ReactElement<
    Record<string, unknown>
  >;
}

function elementText(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(elementText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return Object.values((node as { readonly props: Record<string, unknown> }).props)
      .map(elementText)
      .join("");
  }
  return "";
}

function invokeHandler(handler: unknown, ...args: ReadonlyArray<unknown>): unknown {
  if (typeof handler !== "function") throw new Error("expected an event handler");
  return Reflect.apply(handler, undefined, args);
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("PrimaryBackendSettings", () => {
  beforeEach(() => {
    hooks.reset();
    backendState.value = {
      data: managedState,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
  });

  it("describes managed, invalid, and attached ownership with the matching action", () => {
    const bridge = makeBridge();
    let panel = renderSettings(bridge);
    let action = visitElements(
      panel,
      (element) => elementText(element.props.children) === "Attach backend",
    );
    expect(elementText(panel)).toContain("Started and managed by the desktop app.");
    expect(action?.props.children).toBe("Attach backend");

    backendState.value.data = invalidState;
    panel = renderSettings(bridge);
    action = visitElements(
      panel,
      (element) => elementText(element.props.children) === "Recover attachment",
    );
    expect(elementText(panel)).toContain("needs recovery");
    expect(action?.props.children).toBe("Recover attachment");

    backendState.value.data = attachedState;
    panel = renderSettings(bridge);
    action = visitElements(
      panel,
      (element) => elementText(element.props.children) === "Use desktop backend",
    );
    expect(elementText(panel)).toContain("Using the T3 server at http://127.0.0.1:4773/.");
    expect(action?.props.children).toBe("Use desktop backend");
  });

  it("submits the pairing URL and clears the attach dialog after success", async () => {
    const bridge = makeBridge();
    let panel = renderSettings(bridge);
    const openButton = visitElements(
      panel,
      (element) => element.props.children === "Attach backend",
    );
    invokeHandler(openButton?.props.onClick);

    panel = renderSettings(bridge);
    const input = visitElements(panel, (element) => element.props.placeholder !== undefined);
    invokeHandler(input?.props.onChange, {
      currentTarget: { value: "http://127.0.0.1/pair#token=owner" },
    });
    panel = renderSettings(bridge);
    const updatedInput = visitElements(panel, (element) => element.props.placeholder !== undefined);
    expect(updatedInput?.props.value).toBe("http://127.0.0.1/pair#token=owner");

    const submitButton = visitElements(
      panel,
      (element) => element.props.children === "Attach and restart",
    );
    invokeHandler(submitButton?.props.onClick);
    await flushPromises();

    expect(bridge.attachPrimaryBackend).toHaveBeenCalledWith("http://127.0.0.1/pair#token=owner");
    panel = renderSettings(bridge);
    expect(visitElements(panel, (element) => element.props.open === true)).toBeNull();
    expect(
      visitElements(panel, (element) => element.props.placeholder !== undefined)?.props.value,
    ).toBe("");
  });

  it("keeps attach recovery open and shows the bridge error", async () => {
    const bridge = makeBridge();
    const error = new Error("owner credential rejected");
    vi.mocked(bridge.attachPrimaryBackend).mockRejectedValueOnce(error);
    let panel = renderSettings(bridge);
    const openButton = visitElements(
      panel,
      (element) => element.props.children === "Attach backend",
    );
    invokeHandler(openButton?.props.onClick);
    panel = renderSettings(bridge);
    const input = visitElements(panel, (element) => element.props.placeholder !== undefined);
    invokeHandler(input?.props.onChange, { currentTarget: { value: "owner-url" } });
    panel = renderSettings(bridge);
    const submitButton = visitElements(
      panel,
      (element) => element.props.children === "Attach and restart",
    );
    invokeHandler(submitButton?.props.onClick);
    await flushPromises();

    panel = renderSettings(bridge);
    expect(elementText(panel)).toContain("owner credential rejected");
    expect(visitElements(panel, (element) => element.props.open === true)).not.toBeNull();
    expect(
      visitElements(panel, (element) => element.props.placeholder !== undefined),
    ).not.toBeNull();
  });

  it("calls the managed fallback operation only after confirmation", async () => {
    const bridge = makeBridge();
    backendState.value.data = attachedState;
    let panel = renderSettings(bridge);
    const openButton = visitElements(
      panel,
      (element) => element.props.children === "Use desktop backend",
    );
    invokeHandler(openButton?.props.onClick);
    panel = renderSettings(bridge);
    const confirmation = visitElements(panel, (element) => element.props.open === true);
    const confirmButton = confirmation
      ? visitElements(
          confirmation,
          (element) => elementText(element.props.children) === "Use desktop backend",
        )
      : null;
    expect(bridge.useManagedPrimaryBackend).not.toHaveBeenCalled();
    invokeHandler(confirmButton?.props.onClick);
    await flushPromises();

    expect(bridge.useManagedPrimaryBackend).toHaveBeenCalledOnce();
  });
});
