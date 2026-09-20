import { describe, expect, it } from "vite-plus/test";

import {
  projectGroupTitleNeedsUpdate,
  resolveProjectPickerRouting,
} from "./ProjectSettingsPanel.logic";

const primary = "environment-primary";
const secondary = "environment-wsl";
const secondaryBootstrap = {
  id: "wsl:Ubuntu",
  httpBaseUrl: "http://127.0.0.1:4000",
};

describe("projectGroupTitleNeedsUpdate", () => {
  it("updates divergent member titles even when the next title is the derived group label", () => {
    expect(
      projectGroupTitleNeedsUpdate(["local-title", "remote-title"], "Repository name", true),
    ).toBe(true);
  });

  it("skips an untouched blur when the derived label differs from member titles", () => {
    expect(projectGroupTitleNeedsUpdate(["repo-slug", "repo-slug"], "Repository Name", false)).toBe(
      false,
    );
  });

  it("skips an update when every member already has the next title", () => {
    expect(projectGroupTitleNeedsUpdate(["Shared name", "Shared name"], "Shared name", true)).toBe(
      false,
    );
  });
});

describe("resolveProjectPickerRouting", () => {
  it("keeps the primary picker native and routes a WSL-only primary", () => {
    expect(
      resolveProjectPickerRouting({
        hasDesktopBridge: true,
        environmentId: primary,
        primaryEnvironmentId: primary,
        environmentKind: "primary",
        displayUrl: "http://127.0.0.1:3000",
        desktopLocalBootstraps: [],
        wslConfiguration: null,
      }),
    ).toEqual({ canBrowse: true, targetEnvironmentId: null });

    expect(
      resolveProjectPickerRouting({
        hasDesktopBridge: true,
        environmentId: primary,
        primaryEnvironmentId: primary,
        environmentKind: "primary",
        displayUrl: "http://127.0.0.1:3000",
        desktopLocalBootstraps: [],
        wslConfiguration: {
          enabled: true,
          wslOnly: true,
          distro: "Ubuntu",
          distros: [{ name: "Ubuntu", isDefault: true }],
        },
      }),
    ).toEqual({ canBrowse: true, targetEnvironmentId: "wsl:Ubuntu" });
  });

  it("routes a mapped desktop-local environment to its bootstrap id", () => {
    expect(
      resolveProjectPickerRouting({
        hasDesktopBridge: true,
        environmentId: secondary,
        primaryEnvironmentId: primary,
        environmentKind: "desktop-local",
        displayUrl: secondaryBootstrap.httpBaseUrl,
        desktopLocalBootstraps: [secondaryBootstrap],
        wslConfiguration: null,
      }),
    ).toEqual({ canBrowse: true, targetEnvironmentId: secondaryBootstrap.id });
  });

  it("hides remote, unmapped, and browser-only folder pickers", () => {
    const base = {
      hasDesktopBridge: true,
      environmentId: secondary,
      primaryEnvironmentId: primary,
      displayUrl: secondaryBootstrap.httpBaseUrl,
      desktopLocalBootstraps: [],
      wslConfiguration: null,
    } as const;

    expect(resolveProjectPickerRouting({ ...base, environmentKind: "remote" })).toEqual({
      canBrowse: false,
      targetEnvironmentId: null,
    });
    expect(resolveProjectPickerRouting({ ...base, environmentKind: "desktop-local" })).toEqual({
      canBrowse: false,
      targetEnvironmentId: null,
    });
    expect(
      resolveProjectPickerRouting({
        ...base,
        environmentId: primary,
        environmentKind: "primary",
        hasDesktopBridge: false,
      }),
    ).toEqual({ canBrowse: false, targetEnvironmentId: null });
  });
});
