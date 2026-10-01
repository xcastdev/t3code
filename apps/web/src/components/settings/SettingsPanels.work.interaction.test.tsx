/* @vitest-environment happy-dom */

import { EnvironmentId, ProjectId, DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  enabled: true,
  members: [] as Array<{ environmentId: string; id: string }>,
  kind: "project",
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useLocation: ({ select }: { select: (value: { hash: string; state: object }) => unknown }) =>
    select({ hash: "", state: {} }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => ({ ...DEFAULT_UNIFIED_SETTINGS, projectWorkEnabled: state.enabled }),
  useUpdateScopedSettings: () => vi.fn(),
  useScopedSettingsMixed: () => false,
  useClearScopedSettings: () => vi.fn(),
  useClearProjectOverrides: () => vi.fn(),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: {
      kind: state.kind,
      members: state.members,
      environmentIds: state.members.map((member) => member.environmentId),
    },
    environment: null,
    connectedEnvironments: [],
  }),
  useOptionalSettingsScope: () => ({
    scope: {
      kind: state.kind,
      members: state.members,
      environmentIds: state.members.map((member) => member.environmentId),
    },
    targets: [],
    environments: [],
    connectedEnvironments: [],
  }),
}));
vi.mock("./ProjectDefaultsSettings", () => ({ ProjectDefaultsSettings: () => null }));
vi.mock("./useScopedModelAvailability", () => ({ useScopedModelDisabledReason: () => undefined }));

import { GeneralSettingsPanel } from "./SettingsPanels";

describe("Project Work navigation from Settings", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.navigate.mockReset();
    state.enabled = true;
    state.kind = "project";
    state.members = [{ environmentId: "remote-environment", id: "selected-project" }];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  async function render() {
    await act(async () => root.render(<GeneralSettingsPanel />));
  }
  const action = () =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Open Work",
    );

  it("opens the actual Work route for the selected remote project", async () => {
    await render();
    expect(action()).toBeDefined();
    await act(async () => action()?.click());
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/work/$environmentId/$projectId",
      params: {
        environmentId: EnvironmentId.make("remote-environment"),
        projectId: ProjectId.make("selected-project"),
      },
    });
  });

  it.each(["disabled", "no-selection", "ambiguous", "environment"])(
    "does not choose a destination for %s scope",
    async (kind) => {
      if (kind === "disabled") state.enabled = false;
      if (kind === "no-selection") state.members = [];
      if (kind === "ambiguous")
        state.members.push({ environmentId: "other-environment", id: "other-project" });
      if (kind === "environment") state.kind = "environment";
      await render();
      expect(action()?.disabled).toBe(true);
      await act(async () => action()?.click());
      expect(state.navigate).not.toHaveBeenCalled();
    },
  );
});
