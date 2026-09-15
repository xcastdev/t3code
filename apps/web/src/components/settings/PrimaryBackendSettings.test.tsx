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
const refreshState = vi.hoisted(() => vi.fn());

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
  refreshDesktopPrimaryBackendState: refreshState,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => backendState.value,
}));

import { PrimaryBackendSettings } from "./PrimaryBackendSettings";

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
  return PrimaryBackendSettings({
    bridge: bridge as DesktopBridge,
  }) as ReactElement<Record<string, unknown>>;
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
    refreshState.mockReset();
    backendState.value = {
      data: { mode: "managed" },
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
  });

  it("describes attached ownership and offers the managed fallback", () => {
    backendState.value.data = attachedState;
    const panel = renderSettings(makeBridge());
    expect(elementText(panel)).toContain("Using the T3 server at http://127.0.0.1:4773/.");
    expect(
      visitElements(
        panel,
        (element) => elementText(element.props.children) === "Use desktop backend",
      ),
    ).not.toBeNull();
  });

  it("keeps attachment recovery open after an authorization failure", async () => {
    const bridge = makeBridge();
    vi.mocked(bridge.attachPrimaryBackend).mockRejectedValueOnce(
      new Error("owner credential rejected"),
    );
    let panel = renderSettings(bridge);
    invokeHandler(
      visitElements(panel, (element) => element.props.children === "Attach backend")?.props.onClick,
    );
    panel = renderSettings(bridge);
    invokeHandler(
      visitElements(panel, (element) => element.props.placeholder !== undefined)?.props.onChange,
      { currentTarget: { value: "http://127.0.0.1/pair#token=owner" } },
    );
    panel = renderSettings(bridge);
    invokeHandler(
      visitElements(panel, (element) => element.props.children === "Attach and restart")?.props
        .onClick,
    );
    await flushPromises();

    panel = renderSettings(bridge);
    expect(elementText(panel)).toContain("owner credential rejected");
    expect(visitElements(panel, (element) => element.props.open === true)).not.toBeNull();
    expect(refreshState).toHaveBeenCalledOnce();
  });

  it("only switches to the managed backend after confirmation", async () => {
    backendState.value.data = attachedState;
    const bridge = makeBridge();
    let panel = renderSettings(bridge);
    invokeHandler(
      visitElements(panel, (element) => element.props.children === "Use desktop backend")?.props
        .onClick,
    );
    panel = renderSettings(bridge);
    const confirmation = visitElements(panel, (element) => element.props.open === true);
    expect(bridge.useManagedPrimaryBackend).not.toHaveBeenCalled();
    invokeHandler(
      confirmation
        ? visitElements(
            confirmation,
            (element) => elementText(element.props.children) === "Use desktop backend",
          )?.props.onClick
        : undefined,
    );
    await flushPromises();
    expect(bridge.useManagedPrimaryBackend).toHaveBeenCalledOnce();
    expect(refreshState).toHaveBeenCalledOnce();
  });
});
